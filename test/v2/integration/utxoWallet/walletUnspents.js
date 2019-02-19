//
// Tests for Wallets
//

require('should');

const Promise = require('bluebird');
const co = Promise.coroutine;

const { ManagedWallets } = require('./ManagedWallets');


const wait = co(function *(seconds) {
  console.log(`waiting ${seconds} seconds...`);
  yield Promise.delay(seconds * 1000);
  console.log(`done`);
});

describe('Unspent Manipulation', function() {
  let testWallets;

  before(co(function *() {
    this.timeout(60000);
    testWallets = yield ManagedWallets.create('otto+e2e-utxowallets@bitgo.com');
  }));

  it('should consolidate the number of unspents to 2', co(function *() {
    this.timeout(60000);

    const wallet = yield testWallets.getNextWallet(co(function *(w) {
      const { unspents } = yield w.unspents();
      return unspents.length > 2;
    }));

    const transaction = yield wallet.consolidateUnspents({
      limit: 250,
      numUnspentsToMake: 2,
      minValue: 1000,
      numBlocks: 12,
      walletPassphrase: ManagedWallets.getPassphrase(wallet)
    });
    transaction.status.should.equal('signed');
    yield wait(10);
    (yield wallet.unspents({ limit: 100 })).unspents.length.should.eql(2);
  }));

  it('should fanout the number of unspents to 20', co(function *() {
    this.timeout(60000);

    const wallet = yield testWallets.getNextWallet();
    const transaction = yield wallet.fanoutUnspents({
      minHeight: 1,
      maxNumInputsToUse: 80,
      numUnspentsToMake: 20,
      numBlocks: 12,
      walletPassphrase: ManagedWallets.getPassphrase(wallet)
    });
    transaction.status.should.equal('signed');

    yield wait(10);

    const { unspents } = yield wallet.unspents({ limit: 100 });
    unspents.length.should.equal(20);
  }));

  it('should sweep funds from one wallet to another', co(function *() {
    this.timeout(60000);
    const sweepWallet = yield testWallets.getNextWallet((w) => w.balance() === w.confirmedBalance());
    const targetWallet = yield testWallets.getNextWallet();
    const targetWalletUnspents = (yield targetWallet.unspents()).unspents;

    const transaction = yield sweepWallet.sweep({
      address: targetWallet.receiveAddress(),
      walletPassphrase: ManagedWallets.getPassphrase(sweepWallet)
    });
    transaction.status.should.equal('signed');

    yield wait(10);

    (yield sweepWallet.unspents()).unspents.length.should.equal(0);
    (yield targetWallet.unspents()).unspents.length.should.eql(targetWalletUnspents.length + 1);
  }));
});
