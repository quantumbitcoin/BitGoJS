import * as _ from 'lodash';
import * as Bluebird from 'bluebird';

Bluebird.longStackTraces();

import * as nock from 'nock';

import {Codes, Dimensions, IDimensions} from '@bitgo/unspents';

import debugLib from 'debug';
const debug = debugLib('ManagedWallets');

import * as utxolib from 'bitgo-utxo-lib';
import * as BitGo from '../../../../src/bitgo';

const concurrencyBitGoApi = 4;

export type BitGoWallet = any;

export interface IUnspent {
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

export interface IAddress {
  address: string;
  chain: number;
}

export interface IRecipient {
  address: string;
  amount: number;
}

export declare type ChainCode = number;

enum UnspentType {
  p2sh = "p2sh",
  p2shP2wsh = "p2shP2wsh",
  p2wsh = "p2wsh"
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

export const sumUnspents = (us: IUnspent[]) =>
  us.reduce((sum, u) => sum + u.value, 0);


export interface IWalletConfig {
  name: string;
  getMinUnspents(c: CodeGroup): number;
  getMaxUnspents(c: CodeGroup): number;
}

export interface IWalletLimits {
  minUnspentBalance: number;
  resetUnspentBalance: number;
  minSelfResetBalance: number;
  maxTotalBalance: number;
}

const codeGroups = [Codes.p2sh, Codes.p2shP2wsh, Codes.p2wsh];

const getDimensions = (unspents: IUnspent[], outputScripts: Buffer[]): IDimensions =>
  Dimensions.fromUnspents(unspents)
    .plus(Dimensions.sum(
      ...outputScripts.map((s) => Dimensions.fromOutputScriptLength(s.length))
    ));

const getMaxSpendable = (unspents: IUnspent[], outputScripts: Buffer[], feeRate: number) => {
  const cost = getDimensions(unspents, outputScripts).getVSize() * feeRate / 1000;
  return Math.floor(sumUnspents(unspents) - cost);
};

const dumpUnspents = (unspents: IUnspent[], chain: Timechain, { value = false } = {}): string =>
  unspents
    .map((u) => ({
      chain: u.chain,
      conf: chain.getConfirmations(u),
      ...(value ? { value: u.value } : {})
    }))
    .map((obj) =>
      `{${Object.entries(obj).map(([k, v]) => `${k}=${v}`).join(',')}}`
    )
    .join(',');

const runCollectErrors = async <T>(
  items: T[],
  funcName: string,
  func: (v: T) => Promise<any>
): Promise<Error[]> =>
  (
    await Bluebird.map(items, async (v): Promise<Error | null> => {
      try {
        await func(v);
        return null;
      } catch (e) {
        console.error(`Error for ${v}`, e);
        return e;
      }
    }, { concurrency: concurrencyBitGoApi })
  ).filter((e) => e !== null);

class Timechain {
  public constructor(
    public chainHead: number,
    public network: any,
  ) { }

  public getMaxSpendable(us: IUnspent[], recipients: string[], feeRate: number) {
    return getMaxSpendable(
      us,
      recipients.map((a) => utxolib.address.toOutputScript(a, this.network)),
      feeRate
    );
  }

  public getConfirmations(u: IUnspent) {
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
    public walletConfig: IWalletConfig,
    public wallet: BitGoWallet,
    public unspents: IUnspent[],
    public addresses: IAddress[]
  ) { }

  public getWalletLimits(): IWalletLimits {
    const nMinTotal = codeGroups
      .reduce((sum, codeGroup) => sum + this.walletConfig.getMinUnspents(codeGroup), 0);
    const nResetTotal = nMinTotal * 2;

    const minUnspentBalance = 0.001e8;
    const resetUnspentBalance = minUnspentBalance * 2;
    const minSelfResetBalance = nResetTotal * resetUnspentBalance * 1.1;
    const maxTotalBalance = 2 * nResetTotal * resetUnspentBalance;

    return {
      minUnspentBalance,
      resetUnspentBalance,
      minSelfResetBalance,
      maxTotalBalance
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

  public canSelfReset(): boolean {
    return sumUnspents(this.unspents) > this.getWalletLimits().minSelfResetBalance;
  }

  public shouldRefund(): boolean {
    return sumUnspents(this.unspents) > this.getWalletLimits().maxTotalBalance;
  }

  private getExcessUnspents(unspents: IUnspent[]): IUnspent[] {
    const excessByCode = [Codes.p2sh, Codes.p2shP2wsh, Codes.p2wsh]
      .map((codes) => {
        const us = unspents.filter((u) => codes.has(u.chain));
        const excessCount = this.walletConfig.getMaxUnspents(codes) - us.length;
        return us.slice(0, excessCount);
      });
    return excessByCode.reduce((all, us) => [...all, ...us]);
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
    return addr;
  }

  public async getResetRecipients(us: IUnspent[]): Promise<IRecipient[]> {
    return (await Promise.all(this.getRequiredUnspents(us)
      .map(async ([chain, count]) => {
        if (count <= 0) {
          return [];
        }
        return Promise.all(
          Array(count).fill(0).map(
            async () => (await this.getAddress({ chain })).address
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

  public getRequiredUnspents(unspents: IUnspent[]): [ChainCode, number][] {
    const limits = this.getWalletLimits();

    return [Codes.p2sh, Codes.p2shP2wsh, Codes.p2wsh]
      .map((codes: CodesByPurpose): [ChainCode, number] => {
        const count = unspents
          .filter((u) => u.value > limits.minUnspentBalance)
          .filter((u) => codes.has(u.chain)).length;
        const resetCount = (min, count) => (count >= min) ? 0 : 2 * min - count;
        return [codes.external, resetCount(this.walletConfig.getMinUnspents(codes), count)];
      });
  }

  public needsReset(): { excessBalance: boolean, excessUnspents: boolean, missingUnspent: boolean } | undefined {
    const excessBalance = sumUnspents(this.unspents) > this.getWalletLimits().maxTotalBalance;
    const excessUnspents =
      codeGroups.some((group) =>
        this.unspents.filter((u) => group.has(u.chain)).length > this.walletConfig.getMaxUnspents(group)
      );
    const missingUnspent =
      this.getRequiredUnspents(this.unspents).some(([code, count]) => count > 0);

    debug(`needsReset ${this.wallet.label()}:`);
    debug(` unspents=${dumpUnspents(this.unspents, this.chain)}`);
    debug(` ` + Object
      .entries({ excessBalance, excessUnspents, missingUnspent })
      .filter(([k, v]) => v)
      .map(([k]) => k)
      .join(',') || 'noResetRequired'
    );

    if (excessBalance || excessUnspents || missingUnspent) {
      return { excessBalance, excessUnspents, missingUnspent };
    }
  }

  public async trySelfReset(faucetAddress: string) {
    const recipients = await this.getResetRecipients([]);
    if (recipients.length < 2) {
      // we at least want two recipients so we can use one as the customChangeAddress
      throw new Error(`insufficient resetRecipients`);
    }
    const feeRate = 20_000;
    const changeAddress = this.shouldRefund() ? faucetAddress : recipients.pop().address;
    this.wallet.sendMany({
      feeRate,
      unspents: this.unspents.map((u) => u.id),
      recipients,
      changeAddress,
      walletPassphrase: ManagedWallets.getPassphrase()
    });
  }

  public async trySpendExcessUnspents(faucetAddress: string) {
    const excessUnspents = this.getExcessUnspents(this.unspents);
    if (excessUnspents.length === 0) {
      return;
    }
    const feeRate = 20_000;
    const amount = this.chain.getMaxSpendable(excessUnspents, [faucetAddress], feeRate);
    const { tx: txHex } = await this.wallet.sendMany({
      feeRate,
      unspents: excessUnspents.map(u => u.id),
      recipients: [{ address: faucetAddress, amount }],
      walletPassphrase: ManagedWallets.getPassphrase()
    });
    const parsedTx = this.chain.parseTx(txHex);
    if (parsedTx.outs.length !== 1) {
      throw new Error(`unexpected change output`);
    }
    this.unspents = (await this.wallet.unspents()).unspents;
  }

  public toString(): string {
    return `ManagedWallet[${this.wallet.label()}]`;
  }

  public dump() {
    debug(`wallet ${this.wallet.label()}`);
    debug(` unspents`, dumpUnspents(this.unspents, this.chain));
    debug(` balance`, sumUnspents(this.unspents));
    debug(` needsReset`, this.needsReset());
    debug(` canSelfReset`, this.canSelfReset());
    debug(` shouldRefund`, this.shouldRefund());
  }
}

type ManagedWalletPredicate = (w: BitGoWallet, us: IUnspent[]) => boolean;

export class ManagedWallets {
  static async create(
    env: string,
    clientId: string,
    walletConfig: IWalletConfig,
    poolSize: number = 32
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
      poolSize
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
    return (w: BitGoWallet, us: IUnspent[]) =>
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
  private walletUnspents: Map<BitGoWallet, Promise<IUnspent[]>> = new Map();
  private walletAddresses: Map<BitGoWallet, Promise<IAddress[]>> = new Map();
  private walletConfig: IWalletConfig;
  private poolSize: number;
  private labelPrefix: string;

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
    }: {
      env: string,
      username: string,
      walletConfig: IWalletConfig,
      poolSize: number,
  }) {
    if (!['test', 'dev'].includes(env)) {
      throw new Error(`unsupported env "${env}"`);
    }
    this.password = process.env.BITGOJS_TEST_PASSWORD;
    this.username = username;
    // @ts-ignore
    this.bitgo = new BitGo({ env });
    this.basecoin = this.bitgo.coin('tbtc');
    this.poolSize = poolSize;
    this.walletConfig = walletConfig;
    this.labelPrefix = `managed/${walletConfig.name}`;

    if ('after' in global) {
      const mw = this;
      after(async function () {
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
      otp: ManagedWallets.testUserOTP(),
    });

    if (!response['access_token']) {
      throw new Error(`no access_token in response`);
    }

    await this.bitgo.unlock({ otp: ManagedWallets.testUserOTP() });

    debug(`fetching wallets for ${this.username}...`);
    this.walletList = await this.getWalletList();

    this.faucet = await this.getOrCreateWallet('managed-faucet');

    this.wallets = Promise.all(
      Array(this.poolSize)
        .fill(null)
        .map((v, i) => this.getOrCreateWallet(
          this.getLabelForIndex(i)
        ))
    );

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

  public async getAddresses(w: BitGoWallet, { cache = true }: { cache?: boolean } = {}): Promise<IAddress[]> {
    if (!this.walletAddresses.has(w) || !cache) {
      this.walletAddresses.set(w, (async (): Promise<IAddress[]> => {
        const res = await w.addresses({ limit: 100 });
        if (res.nextBatchPrevId) {
          throw new Error(`excess addresses`);
        }
        return res.addresses;
      })());
    }
    return this.walletUnspents.get(w);
  }

  public async getUnspents(w: BitGoWallet, { cache = true }: { cache?: boolean } = {}): Promise<IUnspent[]> {
    if (!this.walletUnspents.has(w) || !cache) {
      this.walletUnspents.set(w, ((async () => (await w.unspents()).unspents))());
    }
    return this.walletUnspents.get(w);
  }

  /**
   * Returns a wallet with given label. If wallet with label does not exist yet, create it.
   * @param allWallets
   * @param label
   * @return {*}
   */
  private async getOrCreateWallet(
    label: string, { create = true }: { create?: boolean } = {},
  ): Promise<BitGoWallet> {
    const walletsWithLabel = this.walletList
      .filter(w => w.label() === label);
    if (walletsWithLabel.length < 1) {
      if (!create) {
        throw new Error(`no wallet with label ${label} and create=${create}`);
      }
      debug(`no wallet with label ${label} - creating new wallet...`);
      const { wallet } = await this.basecoin.wallets().generateWallet({
        label,
        passphrase: ManagedWallets.getPassphrase(),
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
      async (w) => new ManagedWallet(
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
  async getNextWallet(predicate: ManagedWalletPredicate = () => true): Promise<BitGoWallet> {
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

      if (await Bluebird.resolve(predicate(mw.wallet, mw.unspents))) {
        found = mw;
        break;
      }
    }

    if (found === undefined) {
      throw new Error(
        `No wallet matching criteria found ` +
      `(nUsed=${stats.nUsed},nNeedsReset=${stats.nNeedsReset},nNotReady=${stats.nNotReady})`
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
      async (w) => (await w.unspents()).unspents,
      { concurrency: concurrencyBitGoApi }
    );

    const deleteWallets = wallets.filter((w, i) => walletUnspents[i].length === 0);
    debug(`deleting ${deleteWallets.length} wallets`);
    const deleteErrors = await runCollectErrors(
      deleteWallets,
      'delete',
      (w) => this.bitgo.del(this.basecoin.url('/wallet/' + w.id()))
    );
    deleteErrors.forEach((e) => console.error(e));

    const sweepWallets = wallets.filter((w) => !deleteWallets.includes(w));
    debug(`sweeping ${sweepWallets.length} wallets`);
    const sweepErrors = await runCollectErrors(
      sweepWallets,
      'removeOrDelete',
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
    const faucetAddress = this.faucet.receiveAddress();

    debug(`Checking reset for ${managedWallets.length} wallets:`);
    managedWallets.forEach((mw) => mw.dump());

    const resetWallets = managedWallets.filter((mw) => mw.needsReset());
    const selfResetWallets = resetWallets.filter((mw) => mw.canSelfReset());
    const faucetResetWallets = resetWallets.filter((mw) => !mw.canSelfReset());
    const excessUnspentWallets = faucetResetWallets.filter((mw) => mw.needsReset().excessUnspents);

    const resetErrors = [];

    debug(`exec trySelfReset() for ${selfResetWallets.length} wallets...`);
    resetErrors.push(...await runCollectErrors(
      selfResetWallets,
      `trySelfReset`,
      (mw) => mw.trySelfReset(faucetAddress)
    ));

    debug(`spend excessUnspents ${excessUnspentWallets.length} wallets...`);
    resetErrors.push(...await runCollectErrors(
      excessUnspentWallets,
      `trySpendExcessUnspents`,
      (mw) => mw.trySpendExcessUnspents(faucetAddress)
    ));

    const faucetRecipients =
      (await Bluebird.map(
        faucetResetWallets,
        mw => mw.getResetRecipients(mw.unspents),
        { concurrency: concurrencyBitGoApi }
      ))
      .map((rs: IRecipient[], i) => {
        if (rs.length === 0) {
          resetErrors.push(new Error(`empty faucetRecipients for ${faucetResetWallets[i]}`))
        }
        return rs;
      })
      .reduce((all, rs) => [...all, ...rs], []);

    const faucetBalance = this.faucet.balance();

    const fundableRecipients = [];
    let sum;
    faucetRecipients.every((r) => {
      if (sum += r.amount > faucetBalance) {
        return false;
      }
      fundableRecipients.push(r);
      return true;
    });

    debug(`fund ${fundableRecipients.length} recipients...`);
    if (fundableRecipients.length > 0) {
      const feeRate = 20_000;
      await this.faucet.sendMany({
        feeRate,
        recipients: fundableRecipients,
        walletPassphrase: ManagedWallets.getPassphrase(),
      });
    }

    if (fundableRecipients.length < faucetRecipients.length) {
      resetErrors.push(new Error(
        `Faucet has run dry (faucetBalance=${faucetBalance}) `
        + `Please deposit tbtc at ${faucetAddress}`
      ));
    }

    if (resetErrors.length > 0) {
      resetErrors.forEach((e, i) => console.error(`Error ${i}:`, e));
      throw new Error(`There were ${resetErrors.length} reset errors. See log for details.`);
    }
  }
}

export const makeConfigSingleGroup = (name: string, allowedGroups: CodeGroup[]): IWalletConfig => ({
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

const main = async () => {
  debugLib.enable('ManagedWallets,bitgo:*,superagent:*');

  const { ArgumentParser } = require('argparse');
  const parser = new ArgumentParser();
  const clientId = 'otto+e2e-utxowallets@bitgo.com';
  parser.addArgument(['--env'], { required: true });
  parser.addArgument(['--poolSize'], { required: true, type: Number });
  parser.addArgument(['--group'], { required: true });
  parser.addArgument(['--cleanup'], { nargs: 0 });
  parser.addArgument(['--reset'], { nargs: 0 });
  const { env, poolSize, group: groupName, cleanup, reset } = parser.parseArgs();
  const walletConfig = [GroupPureP2sh, GroupPureP2shP2wsh, GroupPureP2wsh]
    .find(({ name }) => name === groupName);
  if (!walletConfig) {
    throw new Error(`no walletConfig with name ${groupName}`);
  }
  const testWallets = await ManagedWallets.create(
    env,
    clientId,
    walletConfig,
    cleanup ? 0 : poolSize
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
