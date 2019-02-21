import * as _ from 'lodash';
import * as Bluebird from 'bluebird';
import * as assert from 'assert';

import * as nock from 'nock';

import * as BitGo from '../../../../src/bitgo';

type BitGoWallet = any;

class ManagedWallets {
  static isValidLabel(label) {
    return label.match(/^managed-/);
  }

  static async create(clientId) {
    const instance = new ManagedWallets('test', clientId);
    await instance.init();
    return instance;
  }

  static testUserOTP() {
    return '0000000';
  }

  static getPassphrase() {
    // echo -n 'managed' | sha256sum
    return '7fdfda5f50a433ae127a784fc143105fb6d93fedec7601ddeb3d1d584f83de05';
  }

  private password: string;
  private bitgo: any;
  private basecoin: any;
  private wallets: BitGoWallet[];
  private faucet: BitGoWallet;

  /**
   * Because we need an async operation to be ready, please use `const wallets = yield TestWallets.create()` instead
   * @param env
   */
  private constructor(env: string, private username: string) {
    if (env !== 'test') {
      throw new Error(`unsupported env ${env}`);
    }
    this.username = username;
    this.password = process.env.BITGOJS_TEST_PASSWORD;
    // @ts-ignore
    this.bitgo = new BitGo({ env });
    this.basecoin = this.bitgo.coin('tbtc');
  }

  /**
   * Initialize a number wallets with a minimal balance.
   *
   * @param poolSize
   * @param minBalanceSat
   * @return {*}
   */
  private async init({ poolSize = 32, minBalanceSat = 0.01e8 } = {}) {
    nock.cleanAll();
    nock.enableNetConnect();
    await this.bitgo.fetchConstants();

    const response = await this.bitgo.authenticate({
      username: this.username,
      password: this.password,
      otp: ManagedWallets.testUserOTP(),
    });

    if (!response['access_token']) {
      throw new Error(`no access_token in response`);
    }

    await this.bitgo.unlock({ otp: ManagedWallets.testUserOTP() });

    console.log(`fetching wallets for ${this.username}...`);
    const allWallets = await this.getAllWallets();

    this.faucet = await this.getOrCreateWallet(allWallets, 'managed-faucet');

    const wallets = await Promise.all(
      [...Array(poolSize)].map((v, i) => this.getOrCreateWallet(allWallets, `managed-${i}`))
    );

    await this.manageWalletBalances(wallets, { minBalanceSat });

    this.wallets = wallets.filter(w => w.spendableBalance() > minBalanceSat);

    console.log(
      `ManagedWallets: ${this.wallets.length} wallets with sufficient funding. ` +
        `Total managed balance (sat): ${[this.faucet, ...wallets].reduce((sum, w) => sum + w.balance(), 0)}\n`
    );
  }

  /**
   * In order to quickly find a wallet with a certain label, we need to get a list of all wallets.
   * @return {*}
   */
  private async getAllWallets() {
    const allWallets = [];
    let prevId;
    do {
      const page = await this.basecoin.wallets().list({ prevId, limit: 100 });
      prevId = page.nextBatchPrevId;
      allWallets.push(...page.wallets);
    } while (prevId !== undefined);
    return allWallets;
  }

  /**
   * Returns a wallet with given label. If wallet with label does not exist yet, create it.
   * @param allWallets
   * @param label
   * @return {*}
   */
  private async getOrCreateWallet(allWallets: BitGoWallet[], label: string) {
    const walletsWithLabel = allWallets.filter(w => w.label() === label);
    if (walletsWithLabel.length < 1) {
      console.log(`no wallet with label ${label} - creating new wallet...`);
      const { wallet } = await this.basecoin.wallets().generateWallet({
        label,
        passphrase: ManagedWallets.getPassphrase(),
      });
      return wallet;
    } else if (walletsWithLabel.length === 1) {
      console.log(`fetching wallet ${label}...`);
      return this.basecoin.wallets().get({ id: walletsWithLabel[0].id() });
    } else {
      throw new Error(`More than one wallet with label ${label}. Please remove duplicates.`);
    }
  }

  /**
   * Make sure all wallets have a balance between [minBalanceSat, 2 * minBalanceSat].
   * If the balance is below minBalanceSat, fund it from the faucet wallet with _2 * minBalanceSat_.
   *
   * If the spendable balance is above _2 * minBalanceSat_, send everything in excess of _1.5 * minBalanceSat_
   * back to faucet.
   *
   * @param wallets
   * @param minBalanceSat
   * @return {*}
   */
  private async manageWalletBalances(wallets, { minBalanceSat }) {
    assert(!isNaN(minBalanceSat));
    // Try to fund as many wallets as possible. If the faucet has run dry, throw exception at the end.
    const faucetBalance = this.faucet.spendableBalance();
    const faucetAddress = this.faucet.receiveAddress();
    const nFundableWallets = Math.floor(faucetBalance / minBalanceSat);
    const recipientWallets = wallets.filter(w => w.balance() < minBalanceSat);
    const recipients = recipientWallets
      .slice(0, nFundableWallets)
      .map(wallet => ({ address: wallet.receiveAddress(), amount: 2 * minBalanceSat }));

    const txs = [];
    if (recipients.length > 0) {
      console.log(`funding ${recipientWallets.length} wallets from faucet...`);
      txs.push(this.faucet.sendMany({ recipients, walletPassphrase: ManagedWallets.getPassphrase() }));
    }

    const senderWallets = wallets.filter(w => w.spendableBalance() > 2 * minBalanceSat);

    if (senderWallets.length > 0) {
      console.log(`refunding from ${senderWallets.length} wallets back to faucet...`);
      txs.push(
        ...senderWallets.map(wallet =>
          wallet.send({
            address: faucetAddress,
            amount: wallet.spendableBalance() - 1.5 * minBalanceSat,
            walletPassphrase: ManagedWallets.getPassphrase(),
          })
        )
      );
    }

    await Promise.all(txs);

    if (faucetBalance < minBalanceSat * wallets.length) {
      throw new Error(`The faucet has run dry. Please deposit tbtc at address ${faucetAddress}`);
    }
  }

  /**
   * Get next wallet satisfying some criteria
   * @param predicate - Callback with wallet as argument. Can return promise.
   * @return {*}
   */
  async getNextWallet(predicate = (w: BitGoWallet) => true) {
    if (predicate !== undefined) {
      if (!_.isFunction(predicate)) {
        throw new Error(`condition must be function`);
      }
    }

    let found;
    for (const w of this.wallets) {
      if (await Bluebird.resolve(predicate(w))) {
        found = w;
        break;
      }
    }

    if (found === undefined) {
      throw new Error(`No wallet matching criteria found.`);
    }

    // remove wallet from the pool
    this.wallets = this.wallets.filter(w => w !== found);

    return found;
  }
}

module.exports = { ManagedWallets };
