//
// Tests for Wallets
//

require('should');

const Bluebird = require('bluebird');

const { ManagedWallets } = require('./ManagedWallets');


const wait = async (seconds) => {
  console.log(`waiting ${seconds} seconds...`);
  await Promise.delay(seconds * 1000);
  console.log(`done`);
};

describe('Unspent Manipulation', function() {
  let testWallets;

  before(async function () {
    this.timeout(60000);
    testWallets = await ManagedWallets.create('otto+e2e-utxowallets@bitgo.com');
  });

  it('should consolidate the number of unspents to 2', async function () {
    this.timeout(60000);

    const wallet = await testWallets.getNextWallet(async function (w) {
      const { unspents } = await w.unspents();
      return unspents.length > 2;
    });

    const transaction = await wallet.consolidateUnspents({
      limit: 250,
      numUnspentsToMake: 2,
      minValue: 1000,
      numBlocks: 12,
      walletPassphrase: ManagedWallets.getPassphrase(wallet)
    });
    transaction.status.should.equal('signed');
    await wait(10);
    (await wallet.unspents({ limit: 100 })).unspents.length.should.eql(2);
  });

  it('should fanout the number of unspents to 20', async function () {
    this.timeout(60000);

    const wallet = await testWallets.getNextWallet();
    const transaction = await wallet.fanoutUnspents({
      minHeight: 1,
      maxNumInputsToUse: 80,
      numUnspentsToMake: 20,
      numBlocks: 12,
      walletPassphrase: ManagedWallets.getPassphrase(wallet)
    });
    transaction.status.should.equal('signed');

    await wait(10);

    const { unspents } = await wallet.unspents({ limit: 100 });
    unspents.length.should.equal(20);
  });

  it('should sweep funds from one wallet to another', async function () {
    this.timeout(60000);
    const sweepWallet = await testWallets.getNextWallet((w) => w.balance() === w.confirmedBalance());
    const targetWallet = await testWallets.getNextWallet();
    const targetWalletUnspents = (await targetWallet.unspents()).unspents;

    const transaction = await sweepWallet.sweep({
      address: targetWallet.receiveAddress(),
      walletPassphrase: ManagedWallets.getPassphrase(sweepWallet)
    });
    transaction.status.should.equal('signed');

    await wait(10);

    (await sweepWallet.unspents()).unspents.length.should.equal(0);
    (await targetWallet.unspents()).unspents.length.should.eql(targetWalletUnspents.length + 1);
  });
});
