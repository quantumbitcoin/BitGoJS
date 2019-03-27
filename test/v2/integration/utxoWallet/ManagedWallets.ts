import * as _ from 'lodash';
import * as Bluebird from 'bluebird';

Bluebird.longStackTraces();

import * as nock from 'nock';

import { Codes } from '@bitgo/unspents';

import debugLib from 'debug';
const debug = debugLib('ManagedWallets');

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
  private bitgo: any;
  private basecoin: any;
  private chainhead: number;
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
    this.chainhead =
      (await this.bitgo.get(this.basecoin.url('/public/block/latest')).result())
        .height;

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

  private getWalletLimits(wallet: BitGoWallet): IWalletLimits {
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

  private getRequiredUnspents(w: BitGoWallet, unspents: IUnspent[]): [ChainCode, number][] {
    const limits = this.getWalletLimits(w);

    return [Codes.p2sh, Codes.p2shP2wsh, Codes.p2wsh]
      .map((codes: CodesByPurpose): [ChainCode, number] => {
        const count = unspents
          .filter((u) => u.value > limits.minUnspentBalance)
          .filter((u) => codes.has(u.chain)).length;
        const resetCount = (min, count) => (count >= min) ? 0 : 2 * min - count;
        return [codes.external, resetCount(this.walletConfig.getMinUnspents(codes), count)];
      });
  }

  private needsReset(w: BitGoWallet, unspents: IUnspent[]): boolean {
    const excessBalance =
      sumUnspents(unspents) > this.getWalletLimits(w).maxTotalBalance;
    const excessUnspents =
      codeGroups.some((group) =>
          unspents.filter(
            (u) => group.has(u.chain)
          ).length > this.walletConfig.getMaxUnspents(group)
      );
    const missingUnspent =
      this.getRequiredUnspents(w, unspents).some(([code, count]) => count > 0);

    debug(`needsReset ${w.label()}`, { excessBalance, excessUnspents, missingUnspent });

    return excessBalance || excessUnspents || missingUnspent;
  }

  private isConfirmed(u: IUnspent, minConfirms = 3) {
    return (this.chainhead - u.blockHeight) >= minConfirms
  }

  private isReady(w: BitGoWallet, unspents: IUnspent[]): boolean {
    const minConfirms = 3;
    return this.getRequiredUnspents(w, unspents.filter((u) => this.isConfirmed(u)))
      .every(([code, count]) => count <= 0);
  }

  /**
   * Get next wallet satisfying some criteria
   * @param predicate - Callback with wallet as argument. Can return promise.
   * @return {*}
   */
  async getNextWallet(predicate = (w: BitGoWallet, us: IUnspent[]) => true) {
    if (predicate !== undefined) {
      if (!_.isFunction(predicate)) {
        throw new Error(`condition must be function`);
      }
    }

    let found;
    for (const w of (await this.wallets)) {
      if (this.walletsUsed.has(w)) {
        continue;
      }

      const unspents = await this.getUnspents(w);
      if (this.needsReset(w, unspents)) {
        debug(`skipping wallet ${w.label()}: needs reset`);
        continue;
      }

      if (!this.isReady(w, unspents)) {
        debug(`skipping wallet ${w.label()}: not ready`);
        continue;
      }

      if (await Bluebird.resolve(predicate(w, unspents))) {
        found = w;
        break;
      }
    }

    if (found === undefined) {
      throw new Error(`No wallet matching criteria found.`);
    }

    this.walletsUsed.add(found);

    return found;
  }

  async resetWallets() {
    // refresh unspents of used wallets
    for (const w of this.walletsUsed) {
      this.getUnspents(w, { cache: false });
    }

    const wallets = await this.wallets;

    const unspentMap = new Map(
      await Promise.all(
        wallets.map(async (w) => [w, await this.getUnspents(w)])
      ) as [BitGoWallet, IUnspent[]][]
    );

    const faucetAddress = this.faucet.receiveAddress();

    const canSelfReset = (w: BitGoWallet) =>
      sumUnspents(unspentMap.get(w)) > this.getWalletLimits(w).minSelfResetBalance;

    const shouldRefund = (w) =>
      sumUnspents(unspentMap.get(w)) > this.getWalletLimits(w).maxTotalBalance;

    const getResetRecipients = async (w: BitGoWallet, us: IUnspent[]) =>
      (await Promise.all(this.getRequiredUnspents(w, us)
        .map(async ([chain, count]) => {
          if (count <= 0) {
            return [];
          }
          return Promise.all(
            Array(count).fill(0).map(
              async () => {
                const addr = await w.createAddress({ chain });
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
          amount: this.getWalletLimits(w).resetUnspentBalance
        }));

    const getSelfResetTx = async (w: BitGoWallet) => {
      const recipients = await getResetRecipients(w, []);
      if (recipients.length < 2) {
        // we at least want two recipients so we can use one as the customChangeAddress
        throw new Error(`insufficient resetRecipients`);
      }
      const changeAddress = shouldRefund(w) ? faucetAddress : recipients.pop().address;
      try {
        await w.sendMany({
          unspents: unspentMap.get(w).map((u) => u.id),
          recipients,
          changeAddress,
          walletPassphrase: ManagedWallets.getPassphrase()
        });
      } catch (e) {
        throw new Error(`error during self-reset for ${w.label()}: ${e}`);
      }
    };

    {
      debug(`Checking reset for ${wallets.length} wallets:`);
      wallets.forEach((w) => {
        const unspents = unspentMap.get(w);
        debug(`wallet ${w.label()}`);
        debug(` unspents`, unspents.map((u) => [u.chain, u.value, 'confirmed='+this.isConfirmed(u)]));
        debug(` balance`, sumUnspents(unspents));
        debug(` needsReset`, this.needsReset(w, unspents));
        debug(` canSelfReset`, canSelfReset(w));
        debug(` shouldRefund`, shouldRefund(w));
      });
    }

    const resetWallets = (await this.wallets)
      .filter((w) => this.needsReset(w, unspentMap.get(w)));

    await Promise.all(
      resetWallets
      .filter(canSelfReset)
      .map(getSelfResetTx)
    );

    const faucetRecipients =
      (await Promise.all(resetWallets
        .filter((w) => !canSelfReset(w))
        .map((w) => getResetRecipients(w, unspentMap.get(w)))))
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

    if (fundableRecipients.length > 0) {
      await this.faucet.sendMany({
        recipients: fundableRecipients,
        walletPassphrase: ManagedWallets.getPassphrase(),
      });
    }

    if (fundableRecipients.length < faucetRecipients.length) {
      throw new Error(
        `Faucet has run dry (faucetBalance=${faucetBalance}) `
        + `Please deposit tbtc at ${faucetAddress}`
      );
    }
  }
}
