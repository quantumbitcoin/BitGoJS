import * as _ from 'lodash';
import * as Bluebird from 'bluebird';

Bluebird.longStackTraces();

import * as nock from 'nock';

import { Codes, Dimensions, IDimensions } from '@bitgo/unspents';

import debugLib from 'debug';
const debug = debugLib('ManagedWallets');

import * as utxolib from 'bitgo-utxo-lib';
import * as BitGo from '../../../../src/bitgo';

const concurrencyBitGoApi = 4;

const chainGroups = [Codes.p2sh, Codes.p2shP2wsh, Codes.p2wsh];

class DryFaucetError extends Error {
  constructor(faucetWallet: BitGoWallet, spendAmount) {
    super(
      `Faucet has run dry ` +
      `[faucetBalance=${faucetWallet.balance()}, ` +
      `spendable=${faucetWallet.spendableBalance()}, ` +
      `sendAmount=${spendAmount}].`
    + `Please deposit tbtc at ${faucetWallet.receiveAddress()}.`
    );
  }
}

class ErrorExcessSendAmount extends Error {
  constructor(wallet: BitGoWallet, spendAmount) {
    super(
      `Invalid recipients: Receive amount exceeds wallet balance: ` +
      `[wallet=${wallet.label()},` +
      `balance=${wallet.balance()}, ` +
      `spendable=${wallet.spendableBalance()}, ` +
      `sendAmount=${spendAmount}].`
    );
  }
}

export type BitGoWallet = any;

export interface Unspent {
  id: string;
  address: string;
  value: number;
  blockHeight: number;
  date: string;
  wallet: string;
  fromWallet: string;
  chain: number;
  index: number;
  redeemScript: string;
  isSegwit: boolean;
}

export interface Address {
  address: string;
  chain: number;
}

export interface Recipient {
  address: string;
  amount: number;
}

export declare type ChainCode = number;

enum UnspentType {
  p2sh = 'p2sh',
  p2shP2wsh = 'p2shP2wsh',
  p2wsh = 'p2wsh'
}

export declare class CodeGroup {
  values: ReadonlyArray<ChainCode>;
  constructor(values: Iterable<ChainCode>);
  has(code: ChainCode): boolean;
}

export declare class CodesByPurpose extends CodeGroup {
  internal: ChainCode;
  external: ChainCode;
  constructor(t: UnspentType);
}

export const sumUnspents = (us: Unspent[]) =>
  us.reduce((sum, u) => sum + u.value, 0);


export interface WalletConfig {
  name: string;
  getMinUnspents(c: CodeGroup): number;
  getMaxUnspents(c: CodeGroup): number;
}

export interface WalletLimits {
  minUnspentBalance: number;
  maxUnspentBalance: number;
  resetUnspentBalance: number;
}

export interface Send {
  source: BitGoWallet;
  unspents?: string[];
  recipients: Recipient[];
}

const codeGroups = [Codes.p2sh, Codes.p2shP2wsh, Codes.p2wsh];

const getDimensions = (unspents: Unspent[], outputScripts: Buffer[]): IDimensions =>
  Dimensions.fromUnspents(unspents)
  .plus(Dimensions.sum(
    ...outputScripts.map((s) => Dimensions.fromOutputScriptLength(s.length))
  ));

const getMaxSpendable = (unspents: Unspent[], outputScripts: Buffer[], feeRate: number) => {
  if (unspents.length === 0) {
    throw new Error(`must provide at least one unspent`);
  }
  const cost = getDimensions(unspents, outputScripts).getVSize() * feeRate / 1000;
  const amount = Math.floor(sumUnspents(unspents) - cost);
  if (amount < 1000) {
    throw new Error(
      `unspendable unspents ${dumpUnspents(unspents, null, { value: true })} ` +
      `at feeRate=${feeRate}: ${amount}`
    );
  }
  return amount;
};

const dumpUnspents = (unspents: Unspent[], chain?: Timechain, { value = false } = {}): string =>
  unspents
  .map((u) => ({
    chain: u.chain,
    conf: chain ? chain.getConfirmations(u) : undefined,
    ...(value ? { value: u.value } : {})
  }))
  .map((obj) =>
    `{${Object.entries(obj).map(([k, v]) => `${k}=${v}`).join(',')}}`
  )
  .join(',');

const runCollectErrors = async <T>(
  items: T[],
  func: (v: T) => Promise<any>
): Promise<Error[]> =>
  (
    await Bluebird.map(items, async(v): Promise<Error | null> => {
      try {
        await func(v);
        return null;
      } catch (e) {
        console.error(e);
        return e;
      }
    }, { concurrency: concurrencyBitGoApi })
  ).filter((e) => e !== null);

class Timechain {
  public constructor(
    public chainHead: number,
    public network: any,
  ) { }

  public getMaxSpendable(us: Unspent[], recipients: string[], feeRate: number) {
    return getMaxSpendable(
      us,
      recipients.map((a) => utxolib.address.toOutputScript(a, this.network)),
      feeRate
    );
  }

  public getConfirmations(u: Unspent) {
    return Math.max(0, this.chainHead - u.blockHeight + 1);
  }

  public parseTx(txHex: string) {
    return utxolib.Transaction.fromHex(txHex, this.network);
  }
}


export class ManagedWallet {
  public constructor(
    public usedWallets: Set<BitGoWallet>,
    public chain: Timechain,
    public walletConfig: WalletConfig,
    public wallet: BitGoWallet,
    public unspents: Unspent[],
    public addresses: Address[]
  ) { }

  public getWalletLimits(): WalletLimits {
    const nMinTotal = codeGroups
    .reduce((sum, codeGroup) => sum + this.walletConfig.getMinUnspents(codeGroup), 0);

    const minUnspentBalance = 0.001e8;
    const maxUnspentBalance = minUnspentBalance * 4;
    const resetUnspentBalance = minUnspentBalance * 2;
    return {
      minUnspentBalance,
      maxUnspentBalance,
      resetUnspentBalance
    };
  }

  public isUsed(): boolean {
    return this.usedWallets.has(this.wallet);
  }

  public setUsed() {
    this.usedWallets.add(this.wallet);
  }

  public isReady(): boolean {
    return this.getRequiredUnspents(
      this.unspents.filter((u) => this.chain.getConfirmations(u) > 2)
    ).every(([code, count]) => count <= 0);
  }

  private async getAddress({ chain }) {
    let addr = this.addresses.find((a) => a.chain === chain);
    if (addr) {
      return addr;
    }

    addr = await this.wallet.createAddress({ chain });
    if (addr.chain !== chain) {
      throw new Error(`unexpected chain ${addr.chain}, expected ${chain}`);
    }
    this.addresses.push(addr);
    return addr;
  }

  private getAllowedUnspents(unspents: Unspent[]): Unspent[] {
    const valueInRange = (value) =>
      (this.getWalletLimits().minUnspentBalance < value) && (value < this.getWalletLimits().maxUnspentBalance);

    return chainGroups
    .map((grp) =>
      unspents
      .filter((u) => grp.has(u.chain) && valueInRange(u.value))
      .slice(0, this.walletConfig.getMaxUnspents(grp))
    )
    .reduce((all, us) => [...all, ...us]);
  }

  private getExcessUnspents(unspents: Unspent[]): Unspent[] {
    const allowedUnspents = this.getAllowedUnspents(unspents);
    return unspents.filter((u) => !allowedUnspents.includes(u));
  }

  public getRequiredUnspents(unspents: Unspent[]): [ChainCode, number][] {
    const limits = this.getWalletLimits();

    const allowedUnspents = this.getAllowedUnspents(unspents);

    return [Codes.p2sh, Codes.p2shP2wsh, Codes.p2wsh]
    .map((codes: CodesByPurpose): [ChainCode, number] => {
      const count = allowedUnspents
      .filter((u) => u.value > limits.minUnspentBalance)
      .filter((u) => codes.has(u.chain)).length;
      const resetCount = (min, count) => (count >= min) ? 0 : 2 * min - count;
      return [codes.external, resetCount(this.walletConfig.getMinUnspents(codes), count)];
    });
  }

  public needsReset(): { excessUnspents: boolean, missingUnspents: boolean } | undefined {
    const excessUnspents = this.getExcessUnspents(this.unspents);
    const missingUnspents = this.getRequiredUnspents(this.unspents)
    .filter(([code, count]) => count > 0);

    const hasExcessUnspents = excessUnspents.length > 0;
    const hasMissingUnspent = missingUnspents.length > 0;

    const needsReset = hasExcessUnspents || hasMissingUnspent;

    debug(`needsReset ${this.wallet.label()}=${needsReset}`);
    debug(` unspents=${dumpUnspents(this.unspents, this.chain)}`);
    debug(` allowedUnspents=${dumpUnspents(this.getAllowedUnspents(this.unspents), this.chain)}`);
    debug(` excessUnspents=${dumpUnspents(excessUnspents, this.chain)}`);
    debug(` missingUnspents=${missingUnspents.map(([code, count]) => `code=${code},count=${count}`)}`);

    if (needsReset) {
      return {
        excessUnspents: hasMissingUnspent,
        missingUnspents: hasMissingUnspent
      };
    }
  }

  public async getResetRecipients(us: Unspent[]): Promise<Recipient[]> {
    return (await Promise.all(this.getRequiredUnspents(us)
    .map(async([chain, count]) => {
      if (count <= 0) {
        return [];
      }
      return Promise.all(
        Array(count).fill(0).map(
          async() => (await this.getAddress({ chain })).address
        )
      );
    })
    ))
    .reduce((all, rs) => [...all, ...rs])
    .map((address) => ({
      address,
      amount: this.getWalletLimits().resetUnspentBalance
    }));
  }

  /**
   * List of source-target pairs
   */
  public async getSends(faucet: ManagedWallet, feeRate: number): Promise<Send[]> {
    if (!this.needsReset()) {
      return [];
    }
    const sends = [];
    const faucetAddress = (await faucet.getAddress({ chain: 20 })).address;

    const excessUnspents = this.getExcessUnspents(this.unspents);
    if (excessUnspents.length > 0) {
      const refundAmount = this.chain.getMaxSpendable(excessUnspents, [faucetAddress], feeRate);
      sends.push({
        source: this.wallet,
        unspents: excessUnspents.map((u) => u.id),
        recipients: [{ address: faucetAddress, amount: refundAmount }]
      });
    }

    const resetRecipients = await this.getResetRecipients(this.unspents);
    if (resetRecipients.length > 0) {
      sends.push({
        source: faucet.wallet,
        recipients: resetRecipients
      });
    }

    return sends;
  }

  public toString(): string {
    return `ManagedWallet[${this.wallet.label()}]`;
  }

  public dump() {
    debug(`wallet ${this.wallet.label()}`);
    debug(` unspents`, dumpUnspents(this.unspents, this.chain));
    debug(` balance`, sumUnspents(this.unspents));
    debug(` needsReset`, this.needsReset());
  }
}

type ManagedWalletPredicate = (w: BitGoWallet, us: Unspent[]) => boolean;

export class ManagedWallets {
  static async create(
    env: string,
    clientId: string,
    walletConfig: WalletConfig,
    poolSize: number = 32,
    { dryRun = false }: { dryRun?: boolean } = {}
  ): Promise<ManagedWallets> {
    const envPoolSize = 'BITGOJS_MW_POOL_SIZE';
    if (envPoolSize in process.env) {
      poolSize = Number(process.env[envPoolSize]);
      if (isNaN(poolSize)) {
        throw new Error(`invalid value for envvar ${envPoolSize}`);
      }
    }

    return (new ManagedWallets({
      env,
      username: clientId,
      walletConfig,
      poolSize,
      dryRun
    })).init();
  }

  static testUserOTP() {
    return '0000000';
  }

  static getPassphrase() {
    // echo -n 'managed' | sha256sum
    return '7fdfda5f50a433ae127a784fc143105fb6d93fedec7601ddeb3d1d584f83de05';
  }

  public getPredicateUnspentsConfirmed(confirmations: number): ManagedWalletPredicate {
    return (w: BitGoWallet, us: Unspent[]) =>
      us.every((u) => this.chain.getConfirmations(u) >= confirmations);
  }


  public chain: Timechain;

  private username: string;
  private password: string;
  private bitgo: any;
  private basecoin: any;
  private walletList: BitGoWallet[];
  private wallets: Promise<BitGoWallet[]>;
  private usedWallets: Set<BitGoWallet> = new Set();
  private faucet: BitGoWallet;
  private walletUnspents: Map<BitGoWallet, Promise<Unspent[]>> = new Map();
  private walletAddresses: Map<BitGoWallet, Promise<Address[]>> = new Map();
  private walletConfig: WalletConfig;
  private poolSize: number;
  private labelPrefix: string;
  private dryRun: boolean;

  /**
   * Because we need an async operation to be ready, please use
   * `const wallets = yield TestWallets.create()` instead
   */
  private constructor(
    {
      env,
      username,
      walletConfig,
      poolSize,
      dryRun
    }: {
      env: string,
      username: string,
      walletConfig: WalletConfig,
      poolSize: number,
      dryRun: boolean,
  }) {
    if (!['test', 'dev'].includes(env)) {
      throw new Error(`unsupported env "${env}"`);
    }
    this.password = process.env.BITGOJS_TEST_PASSWORD;
    if (!this.password) {
      throw new Error(`envvar not set: BITGOJS_TEST_PASSWORD`);
    }
    this.username = username;
    // @ts-ignore
    this.bitgo = new BitGo({ env });
    this.basecoin = this.bitgo.coin('tbtc');
    this.poolSize = poolSize;
    this.walletConfig = walletConfig;
    this.labelPrefix = `managed/${walletConfig.name}`;
    this.dryRun = dryRun;

    if ('after' in global) {
      const mw = this;
      after(async function() {
        this.timeout(600_000);
        debug('resetWallets() start');
        await mw.resetWallets();
        debug('resetWallets() finished');
      });
    }
  }

  private isValidLabel(label) {
    return label.startsWith(this.labelPrefix);
  }

  private getLabelForIndex(i: number) {
    return `${this.labelPrefix}/${i}`;
  }

  private getWalletIndex(wallet: BitGoWallet): number {
    const idx = wallet.label().replace(`^${this.labelPrefix}`, '');
    if (isNaN(idx)) {
      throw new Error(`cannot determine index from ${wallet.label()}`);
    }
    return Number(idx);
  }

  private async init(): Promise<this> {
    debug(`init poolSize=${this.poolSize}`);
    nock.cleanAll();
    nock.enableNetConnect();
    await this.bitgo.fetchConstants();

    const { height } = await this.bitgo.get(this.basecoin.url('/public/block/latest')).result();
    this.chain = new Timechain(height, this.basecoin._network);

    const response = await this.bitgo.authenticate({
      username: this.username,
      password: this.password,
      otp: ManagedWallets.testUserOTP()
    });

    if (!response['access_token']) {
      throw new Error(`no access_token in response`);
    }

    await this.bitgo.unlock({ otp: ManagedWallets.testUserOTP() });

    debug(`fetching wallets for ${this.username}...`);
    this.walletList = await this.getWalletList();

    this.faucet = await this.getOrCreateWallet('managed-faucet');

    this.wallets = (async() => await Bluebird.map(
      Array(this.poolSize).fill(null).map((v, i) => i),
      (i) => this.getOrCreateWallet(this.getLabelForIndex(i)),
      { concurrency: 4 }
    ))();

    return this;
  }

  /**
   * In order to quickly find a wallet with a certain label, we need to get a list of all wallets.
   * @return {*}
   */
  private async getWalletList() {
    const allWallets = [];
    let prevId;
    do {
      const page = await this.basecoin.wallets().list({ prevId, limit: 100 });
      prevId = page.nextBatchPrevId;
      allWallets.push(...page.wallets);
    } while (prevId !== undefined);
    return allWallets;
  }

  public async getAddresses(w: BitGoWallet, { cache = true }: { cache?: boolean } = {}): Promise<Address[]> {
    if (!this.walletAddresses.has(w) || !cache) {
      this.walletAddresses.set(w, (async(): Promise<Address[]> =>
        (await Bluebird.map(
          chainGroups,
          async(group) => (await w.addresses({ limit: 100, chains: group.values })).addresses,
          { concurrency: 2 }
        )).reduce((all, addrs) => [...all, ...addrs])
      )());
    }
    return this.walletAddresses.get(w);
  }

  public async getUnspents(w: BitGoWallet, { cache = true }: { cache?: boolean } = {}): Promise<Unspent[]> {
    if (!this.walletUnspents.has(w) || !cache) {
      this.walletUnspents.set(w, ((async() => (await w.unspents()).unspents))());
    }
    return this.walletUnspents.get(w);
  }

  /**
   * Returns a wallet with given label. If wallet with label does not exist yet, create it.
   * @param allWallets
   * @param label
   * @return {*}
   */
  private async getOrCreateWallet(label: string): Promise<BitGoWallet> {
    const walletsWithLabel = this.walletList
    .filter(w => w.label() === label);
    if (walletsWithLabel.length < 1) {
      debug(`no wallet with label ${label} - creating new wallet...`);
      if (this.dryRun) {
        throw new Error(`not creating new wallet (dryRun=true)`);
      }
      const { wallet } = await this.basecoin.wallets().generateWallet({
        label,
        passphrase: ManagedWallets.getPassphrase()
      });
      this.walletUnspents.set(wallet, Promise.resolve([]));
      return wallet;
    } else if (walletsWithLabel.length === 1) {
      debug(`fetching wallet ${label}...`);
      const thinWallet = walletsWithLabel[0];
      const walletId = thinWallet.id();
      const wallet = await this.basecoin.wallets().get({ id: walletId });
      this.getUnspents(wallet);
      return wallet;
    } else {
      throw new Error(`More than one wallet with label ${label}. Please remove duplicates.`);
    }
  }

  public async getAll(): Promise<ManagedWallet[]> {
    return Bluebird.map(
      (await this.wallets),
      async(w) => new ManagedWallet(
        this.usedWallets,
        this.chain,
        this.walletConfig,
        w,
        await this.getUnspents(w),
        await this.getAddresses(w),
      ),
      { concurrency: concurrencyBitGoApi }
    );
  }

  /**
   * Get next wallet satisfying some criteria
   * @param predicate - Callback with wallet as argument. Can return promise.
   * @return {*}
   */
  async getNextWallet(predicate?: ManagedWalletPredicate): Promise<BitGoWallet> {
    if (predicate !== undefined) {
      if (!_.isFunction(predicate)) {
        throw new Error(`condition must be function`);
      }
    }

    let found: ManagedWallet | undefined;
    const stats = { nUsed: 0, nNeedsReset: 0, nNotReady: 0 };

    for (const mw of await this.getAll()) {
      const isUsed = this.usedWallets.has(mw.wallet);
      const needsReset = mw.needsReset();
      const notReady = !mw.isReady();

      stats.nUsed += isUsed ? 1 : 0;
      stats.nNeedsReset += needsReset ? 1 : 0;
      stats.nNotReady += notReady ? 1 : 0;

      if (isUsed) {
        continue;
      }

      if (needsReset) {
        debug(`skipping wallet ${mw}: needs reset`);
        continue;
      }

      if (notReady) {
        debug(`skipping wallet ${mw}: not ready`);
        continue;
      }

      if (predicate === undefined || (await Bluebird.resolve(predicate(mw.wallet, mw.unspents)))) {
        found = mw;
        break;
      }
    }

    if (found === undefined) {
      throw new Error(
        `No wallet matching criteria found ` +
      `(`
        + `nUsed=${stats.nUsed},`
        + `nNeedsReset=${stats.nNeedsReset},`
        + `nNotReady=${stats.nNotReady},`
        + `predicate=${predicate}`
        + `)`
      );
    }

    debug(`found wallet ${found} unspents=${dumpUnspents(found.unspents, this.chain, { value: true })}`);

    found.setUsed();
    return found.wallet;
  }

  async removeAllWallets() {
    const faucetAddress = this.faucet.receiveAddress();
    const wallets = this.walletList
    .filter((thinWallet) => thinWallet.id() !== this.faucet.id())
    .map((thinWallet) => this.basecoin.wallets().get({ id: thinWallet.id() }));

    const walletUnspents = await Bluebird.map(
      wallets,
      async(w) => (await w.unspents()).unspents,
      { concurrency: concurrencyBitGoApi }
    );

    const deleteWallets = wallets.filter((w, i) => walletUnspents[i].length === 0);
    debug(`deleting ${deleteWallets.length} wallets`);
    const deleteErrors = await runCollectErrors(
      deleteWallets,
      (w) => this.bitgo.del(this.basecoin.url('/wallet/' + w.id()))
    );
    deleteErrors.forEach((e) => console.error(e));

    const sweepWallets = wallets.filter((w) => !deleteWallets.includes(w));
    debug(`sweeping ${sweepWallets.length} wallets`);
    const sweepErrors = await runCollectErrors(
      sweepWallets,
      (w) =>
        w.sweep({
          feeRate: 1000,
          address: faucetAddress,
          walletPassphrase: ManagedWallets.getPassphrase()
        })
    );
    sweepErrors.forEach((e) => console.error(e));

    if (sweepWallets.length > 0) {
      throw new Error(
        `${sweepWallets.length} wallets still had unspents. ` +
      `Please try again when sweep tx have confirmed`
      );
    }
  }

  async resetWallets() {
    // refresh unspents of used wallets
    for (const mw of await this.getAll()) {
      if (mw.isUsed()) {
        this.getUnspents(mw.wallet, { cache: false });
      }
    }

    const managedWallets = await this.getAll();
    const faucet = this.faucet;
    const managedFaucet = new ManagedWallet(
      this.usedWallets,
      this.chain,
      this.walletConfig,
      faucet,
      await this.getUnspents(faucet),
      await this.getAddresses(faucet)
    );

    debug(`Checking reset for ${managedWallets.length} wallets:`);
    managedWallets.forEach((mw) => mw.dump());

    const feeRate = 10_000;
    const sends = await Promise.all(managedWallets.map((m) => m.getSends(managedFaucet, feeRate)));
    const sendsByWallet: Map<BitGoWallet, Send[]> = sends
    .reduce((all, sends) => [...all, ...sends], [])
    .reduce((map, send: Send) => {
      const sds = map.get(send.source) || [];
      map.set(send.source, [...sds, send]);
      return map;
    }, new Map());

    sendsByWallet.forEach((sends, wallet) => {
      debug(`${wallet.label()} ->`);
      sends.forEach((send) => {
        send.recipients.forEach((r) => { debug(`  ${r.address} ${r.amount}`); });
      });
    });

    await runCollectErrors(
      [...sendsByWallet.entries()],
      async([w, sends]) => {
        if (sends.length === 0) {
          throw new Error(`no sends for ${w}`);
        }

        let unspents;
        if (sends.length === 1) {
          unspents = sends[0].unspents;
        } else {
          if (!sends.every(({ unspents }) => unspents === undefined)) {
            throw new Error(`cannot declare unspent in send with more than one send per wallet`);
          }
        }

        const recipients =
          sends.reduce((rs, s: Send) => [...rs, ...s.recipients], []);

        const sum = recipients.reduce((sum, v) => sum + v.amount, 0);
        if (sum > w.spendableBalance()) {
          if (w === faucet) {
            throw new DryFaucetError(faucet, sum);
          }
          throw new ErrorExcessSendAmount(w, sum);
        }

        if (this.dryRun) {
          console.warn(`dryRun set: skipping sendMany for ${w.label()}`);
          return;
        }
        await w.sendMany({
          feeRate,
          unspents,
          recipients,
          walletPassphrase: ManagedWallets.getPassphrase()
        });
      }
    );
  }
}

export const makeConfigSingleGroup = (name: string, allowedGroups: CodeGroup[]): WalletConfig => ({
  name,

  getMinUnspents(c: CodeGroup): number {
    return allowedGroups.includes(c) ? 2 : 0;
  },
  getMaxUnspents(c: CodeGroup): number {
    return allowedGroups.includes(c) ? Infinity : 0;
  }
});

export const GroupPureP2sh = makeConfigSingleGroup('pure-p2sh', [Codes.p2sh]);
export const GroupPureP2shP2wsh = makeConfigSingleGroup('pure-p2shP2wsh', [Codes.p2shP2wsh]);
export const GroupPureP2wsh = makeConfigSingleGroup('pure-p2wsh', [Codes.p2wsh]);

const main = async() => {
  // debugLib.enable('ManagedWallets,bitgo:*,superagent:*');
  debugLib.enable('ManagedWallets');

  const { ArgumentParser } = require('argparse');
  const parser = new ArgumentParser();
  const clientId = 'otto+e2e-utxowallets@bitgo.com';
  parser.addArgument(['--env'], { required: true });
  parser.addArgument(['--poolSize'], { required: true, type: Number });
  parser.addArgument(['--group'], { required: true });
  parser.addArgument(['--cleanup'], { nargs: 0 });
  parser.addArgument(['--dryRun'], { nargs: 0 });
  parser.addArgument(['--reset'], { nargs: 0 });
  const { env, poolSize, group: groupName, cleanup, reset, dryRun } = parser.parseArgs();
  const walletConfig = [GroupPureP2sh, GroupPureP2shP2wsh, GroupPureP2wsh]
  .find(({ name }) => name === groupName);
  if (!walletConfig) {
    throw new Error(`no walletConfig with name ${groupName}`);
  }
  const testWallets = await ManagedWallets.create(
    env,
    clientId,
    walletConfig,
    cleanup ? 0 : poolSize,
    { dryRun }
  );

  if ([cleanup, reset].filter(Boolean).length !== 1) {
    throw new Error(`must pick one of "cleanup" or "reset"`);
  }

  if (cleanup) {
    await testWallets.removeAllWallets();
  }

  if (reset) {
    await testWallets.resetWallets();
  }
};

process.addListener('unhandledRejection', (e) => {
  console.error(e);
  process.abort();
});

if (require.main === module) {
  main()
  .catch((e) => {
    console.error(e);
    process.abort();
  });
}
