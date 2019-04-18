//
// Tests for Wallets
//

import {
  GroupPureP2sh,
  GroupPureP2shP2wsh,
  GroupPureP2wsh,
  WalletConfig,
  ManagedWallets
} from './ManagedWallets';

import 'should';

import * as Bluebird from 'bluebird';

import debugLib from 'debug';
const debug = debugLib('integration-test-wallet-unspents');

const wait = async(seconds) => {
  debug(`waiting ${seconds} seconds...`);
  await Bluebird.delay(seconds * 1000);
  debug(`done`);
};

const walletPassphrase = ManagedWallets.getPassphrase();

const skipTest = (groupName) => {
  const groups = process.env.BITGOJS_INTTEST_GROUPS;
  return (groups !== undefined) && !groups.split(',').includes(groupName);
};

const runTests = (walletConfig: WalletConfig) => {
  let testWallets: ManagedWallets;

  const env = process.env.BITGO_ENV || 'test';
  describe(`Wallets env=${env} group=${walletConfig.name}`, function() {
    if (skipTest(walletConfig.name)) {
      console.log(`skipping ${walletConfig.name}`);
      return;
    }

    before(async function() {
      this.timeout(120_000);
      testWallets = await ManagedWallets.create(
        env,
        'otto+e2e-utxowallets@bitgo.com',
        walletConfig,
      );
    });

    it('should self-send to new default receive addr', async function() {
      this.timeout(60_000);
      const wallet = await testWallets.getNextWallet();
      const unspents = await testWallets.getUnspents(wallet);
      const address = wallet.receiveAddress();
      const feeRate = 10_000;
      const amount = Math.floor(testWallets.chain.getMaxSpendable(unspents, [address], feeRate) / 2);
      await wallet.sendMany({
        feeRate,
        recipients: [{ address, amount }],
        walletPassphrase: ManagedWallets.getPassphrase()
      });
    });

    it('should consolidate the number of unspents to 2', async function() {
      this.timeout(60_000);

      const wallet = await testWallets.getNextWallet((w, unspents) => unspents.length >= 4);

      const transaction = await wallet.consolidateUnspents({
        limit: 250,
        numUnspentsToMake: 2,
        minValue: 1000,
        numBlocks: 12,
        walletPassphrase
      });
      transaction.status.should.equal('signed');
      await wait(20);
      (await wallet.unspents({ limit: 100 })).unspents.length.should.eql(2);
    });

    it('should fanout the number of unspents to 20', async function() {
      this.timeout(60_000);

      const wallet = await testWallets.getNextWallet();
      // it sometimes complains with high feeRates
      const feeRate = 1200;
      const transaction = await wallet.fanoutUnspents({
        feeRate,
        minHeight: 1,
        maxNumInputsToUse: 80,
        numUnspentsToMake: 20,
        numBlocks: 12,
        walletPassphrase
      });
      transaction.status.should.equal('signed');

      await wait(10);
      const { unspents } = await wallet.unspents({ limit: 100 });
      unspents.length.should.equal(20);
    });

    it('should sweep funds from one wallet to another', async function() {
      this.timeout(60_000);
      const sweepWallet = await testWallets.getNextWallet(testWallets.getPredicateUnspentsConfirmed(6));
      const targetWallet = await testWallets.getNextWallet();
      const targetWalletUnspents = await testWallets.getUnspents(targetWallet);

      const transaction = await sweepWallet.sweep({
        address: targetWallet.receiveAddress(),
        walletPassphrase
      });
      transaction.status.should.equal('signed');

      await wait(10);

      (await sweepWallet.unspents()).unspents.length.should.equal(0);
      (await targetWallet.unspents()).unspents.length.should.eql(targetWalletUnspents.length + 1);
    });

    it('should make tx with bnb exactMatch', async function() {
      this.timeout(60_000);
      const wallet = await testWallets.getNextWallet();
      const unspents = await testWallets.getUnspents(wallet);
      const feeRate = 10_000;
      const address = wallet.receiveAddress();
      const amount = testWallets.chain.getMaxSpendable(unspents, [address], feeRate);
      const prebuild = await wallet.prebuildTransaction({
        recipients: [{ address, amount }],
        strategy: 'BNB',
        strategyAllowFallback: false,
        feeRate,
        walletPassphrase
      });
      // FIXME: how do we know BnB was used?
      // At least we have sent strategyAllowFallback=false

      // FIXME: vsize mismatch due to mismatched unspents lib
      // prebuild.feeInfo.size.should.eql(dims.getVSize());
      (prebuild === undefined).should.be.false();
    });
  });
};

describe('Unspent Manipulation', function() {
  runTests(GroupPureP2sh);
  runTests(GroupPureP2shP2wsh);
  runTests(GroupPureP2wsh);
});
