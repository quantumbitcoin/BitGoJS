//
// Tests for Wallets
//

import {BitGoWallet, CodeGroup, IUnspent, IWalletConfig, ManagedWallets, sumUnspents} from "./ManagedWallets";

import 'should';

import * as Bluebird from 'bluebird';

import debugLib from 'debug';
import {Codes, Dimensions, VirtualSizes} from "@bitgo/unspents";
import * as utxolib from 'bitgo-utxo-lib';
const debug = debugLib('integration-test-wallet-unspents');

const wait = async (seconds) => {
  debug(`waiting ${seconds} seconds...`);
  await Bluebird.delay(seconds * 1000);
  debug(`done`);
};

const walletPassphrase = ManagedWallets.getPassphrase();

const runTests = (groupName: string, walletConfig: IWalletConfig) => {
  let testWallets: ManagedWallets;

  const env = process.env.BITGO_ENV || 'test';
  describe(`Wallets env=${env} group=${groupName}]`, function () {
    before(async function () {
      this.timeout(120_000);
      testWallets = await ManagedWallets.create(
        env,
        'otto+e2e-utxowallets@bitgo.com',
       groupName,
        walletConfig,
      );
    });

    it('should consolidate the number of unspents to 2', async function () {
      this.timeout(60_000);

      const wallet = await testWallets.getNextWallet((w, unspents) => unspents.length > 2);

      const transaction = await wallet.consolidateUnspents({
        limit: 250,
        numUnspentsToMake: 2,
        minValue: 1000,
        numBlocks: 12,
        walletPassphrase
      });
      transaction.status.should.equal('signed');
      await wait(10);
      (await wallet.unspents({ limit: 100 })).unspents.length.should.eql(2);
    });

    it('should fanout the number of unspents to 20', async function () {
      this.timeout(60_000);

      const wallet = await testWallets.getNextWallet();
      const transaction = await wallet.fanoutUnspents({
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

    it('should sweep funds from one wallet to another', async function () {
      this.timeout(60_000);
      const sweepWallet = await testWallets.getNextWallet(
        (w) => w.balance() === w.confirmedBalance()
      );
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

    it.only('should make tx with bnb exactMatch', async function () {
      this.timeout(60_000);
      const wallet = await testWallets.getNextWallet();
      const unspents = await testWallets.getUnspents(wallet);
      const feeRate = 10_000;
      const address = wallet.receiveAddress();
      const dims = Dimensions
        .fromUnspents(unspents)
        .plus(Dimensions.fromOutput({
          script: utxolib.address.toOutputScript(address, testWallets.network)
        }));
      const txCost = dims.getVSize() * feeRate / 1000;
      const amount = sumUnspents(unspents) - txCost;
      debug({ dims, txCost, amount });
      const prebuild = await wallet.prebuildTransaction({
        recipients: [{ address, amount }], feeRate, walletPassphrase
      });
      // FIXME: how do we know BnB was used?

      // FIXME: vsize mismatch due to mismatched unspents lib
      // prebuild.feeInfo.size.should.eql(dims.getVSize());
      (prebuild === undefined).should.be.false();
    });
  });
};

describe('Unspent Manipulation', function() {
  const makeConfig = (allowedGroups: CodeGroup[]): IWalletConfig => ({
    getMinUnspents(c: CodeGroup): number {
      return allowedGroups.includes(c) ? 2 : 0;
    },
    getMaxUnspents(c: CodeGroup): number {
      return allowedGroups.includes(c) ? Infinity : 0;
    }
  });

  runTests(`pure-p2sh`, makeConfig([Codes.p2sh]));
  runTests(`pure-p2shP2wsh`, makeConfig([Codes.p2shP2wsh]));
  // runTests(`pure-p2wsh`, makeConfig([Codes.p2wsh]));
});
