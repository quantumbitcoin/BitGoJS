import * as _ from 'lodash';
import * as Bluebird from 'bluebird';

Bluebird.longStackTraces();

import * as nock from 'nock';

import {Codes, Dimensions, IDimensions} from '@bitgo/unspents';

import debugLib from 'debug';
const debug = debugLib('ManagedWallets');

import * as utxolib from 'bitgo-utxo-lib';
import * as BitGo from '../../../../src/bitgo';

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

const dumpUnspents = (unspents: IUnspent[], chain: Timechain): string =>
  unspents
    .map((u) => `{chain=${u.chain},conf=${chain.getConfirmations(u)}}`)
    .join(',');


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
  public used = false;

  public constructor(
    public chain: Timechain,
    public walletConfig: IWalletConfig,
    public wallet: BitGoWallet,
    public unspents: IUnspent[],
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
    return this.used;
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

  public async getResetRecipients(us: IUnspent[]): Promise<IRecipient[]> {
    return (await Promise.all(this.getRequiredUnspents(us)
      .map(async ([chain, count]) => {
        if (count <= 0) {
          return [];
        }
        return Promise.all(
          Array(count).fill(0).map(
            async () => {
              const addr = await this.wallet.createAddress({ chain });
              if (addr.chain !== chain) {
                throw new Error(`unexpected chain ${addr.chain}, expected ${chain}`);
              }
              return addr.address;
            }
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
    const changeAddress = this.shouldRefund() ? faucetAddress : recipients.pop().address;
    return this.wallet.sendMany({
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
    const feeRate = 10_000;
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

export class ManagedWallets {
  static async create(
    env: string,
    clientId: string,
    groupName: string,
    walletConfig: IWalletConfig,
  ): Promise<ManagedWallets> {
    let poolSize: number | undefined;
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
      groupName,
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



  public network: any;

  private username: string;
  private password: string;
  private chain: Timechain;
  private bitgo: any;
  private basecoin: any;
  private walletList: BitGoWallet[];
  private wallets: Promise<BitGoWallet[]>;
  private faucet: BitGoWallet;
  private walletUnspents: Map<BitGoWallet, Promise<IUnspent[]>> = new Map();
  private walletsUsed: Set<BitGoWallet> = new Set();
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
      groupName,
      walletConfig,
      poolSize = 32,
    }: {
      env: string,
      username: string,
      groupName: string
      walletConfig: IWalletConfig,
      poolSize?: number,
  }) {
    if (!['test', 'dev'].includes(env)) {
      throw new Error(`unsupported env ${env}`);
    }
    this.password = process.env.BITGOJS_TEST_PASSWORD;
    this.username = username;
    // @ts-ignore
    this.bitgo = new BitGo({ env });
    this.basecoin = this.bitgo.coin('tbtc');
    this.network = this.basecoin._network;
    this.poolSize = poolSize;
    this.walletConfig = walletConfig;
    this.labelPrefix = `managed/${groupName}/`;

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

  /**
   * Initialize a number wallets with a minimal balance.
   *
   * @param poolSize
   * @param minBalanceSat
   * @return {*}
   */
  private async init(): Promise<this> {
    debug(`init poolSize=${this.poolSize}`);
    nock.cleanAll();
    nock.enableNetConnect();
    await this.bitgo.fetchConstants();

    const { height } = await this.bitgo.get(this.basecoin.url('/public/block/latest')).result();
    this.chain = new Timechain(height, this.network);

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
          this.getLabelForIndex(i),
          { renameFrom: `managed-${i}` }
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
    label: string, { renameFrom }: { renameFrom?: string } = {},
  ): Promise<BitGoWallet> {
    const walletsWithLabel = this.walletList
      .filter(
        w => w.label() === label
        || (renameFrom !== undefined && label === renameFrom)
      );
    if (walletsWithLabel.length < 1) {
      debug(`no wallet with label ${label} - creating new wallet...`);
      const { wallet } = await this.basecoin.wallets().generateWallet({
        label,
        passphrase: ManagedWallets.getPassphrase(),
      });
      this.walletUnspents.set(wallet, Promise.resolve([]));
      return wallet// ;
    } else if (walletsWithLabel.length === 1) {
      debug(`fetching wallet ${label}...`);
      const thinWallet = walletsWithLabel[0];
      const walletId = thinWallet.id();
      if (thinWallet.label() !== label) {
        if (renameFrom === undefined) {
          throw new Error(`wrong label`);
        }
        await this.bitgo
          .put(this.basecoin.url(`/wallet/${walletId}`))
          .send({ label })
          .result();
        return this.getOrCreateWallet(label);
      }
      const wallet = await this.basecoin.wallets().get({ id: walletId });
      this.getUnspents(wallet);
      return wallet;
    } else {
      throw new Error(`More than one wallet with label ${label}. Please remove duplicates.`);
    }
  }

  public async getAll(): Promise<ManagedWallet[]> {
    return Promise.all((await this.wallets).map(
      async (w) => new ManagedWallet(this.chain, this.walletConfig, w, await this.getUnspents(w))
    ));
  }

  /**
   * Get next wallet satisfying some criteria
   * @param predicate - Callback with wallet as argument. Can return promise.
   * @return {*}
   */
  async getNextWallet(predicate = (w: BitGoWallet, us: IUnspent[]) => true): Promise<BitGoWallet> {
    if (predicate !== undefined) {
      if (!_.isFunction(predicate)) {
        throw new Error(`condition must be function`);
      }
    }

    let found: ManagedWallet | undefined;
    const stats = { nUsed: 0, nNeedsReset: 0, nNotReady: 0 };

    for (const mw of await this.getAll()) {
      const isUsed = mw.isUsed();
      const needsReset = mw.needsReset();
      const notReady = !mw.needsReset();

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

    found.used = true;

    return found.wallet;
  }

  async resetWallets() {
    // refresh unspents of used wallets
    for (const w of this.walletsUsed) {
      this.getUnspents(w, { cache: false });
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

    const runCollectErrors = async (tag: string, errors: Error[], promises: Promise<any>[]) => {
      errors.push(...(
        await Promise.all(promises.map(async (p): Promise<Error | null> => {
          try {
            await p;
            return null;
          } catch (e) {
            e.message = `Error in ${tag}: ${e.message}`;
            return e;
          }
        }))
      ).filter((e) => e !== null))
    };

    debug(`exec trySelfReset() for ${selfResetWallets.length} wallets...`);
    runCollectErrors(
      `trySelfReset`,
      resetErrors,
      resetWallets.map(mw => mw.trySelfReset(faucetAddress))
    );

    debug(`spend excessUnspents ${excessUnspentWallets.length} wallets...`);
    runCollectErrors(
      `trySpendExcessUnspents`,
      resetErrors,
      resetWallets.map(mw => mw.trySpendExcessUnspents(faucetAddress))
    );

    const faucetRecipients =
      (await Promise.all(faucetResetWallets.map(mw => mw.getResetRecipients(faucetAddress))))
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
      await this.faucet.sendMany({
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
