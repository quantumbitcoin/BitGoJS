//
// Tests for Wallets
//

const Promise = require('bluebird');
const co = Promise.coroutine;
const nock = require('nock');
const BigNumber = require('bignumber.js');

const TestV2BitGo = require('../../../lib/test_bitgo');

const getWalletWithMinBalance = co(function *(bitgo, id, minimum) {
  const wallet = yield bitgo.coin('tbtc').wallets().getWallet({ id });
  const balance = new BigNumber(wallet.spendableBalanceString());
  if (balance.lt(minimum)) {
    const { address: receiveAddress } = yield wallet.createAddress();
    throw new Error(
      `The TBTC wallet ${wallet.id()} does not have enough funds to run the test suite. ` +
      `The current balance is ${balance / 1e8}, the minimum is ${minimum / 1e8}. ` +
      `Please fund this wallet by sending TBTC to ${receiveAddress}.`
    );
  }
  return wallet;
});

const wait = co(function *(seconds) {
  console.log(`waiting ${seconds} seconds...`);
  yield Promise.delay(seconds * 1000);
  console.log(`done`);
});

describe('Unspent Manipulation', function() {
  let bitgo;
  let basecoin;

  let consolidationWallet;
  let sweep1Wallet;
  let sweep2Wallet;

  before(co(function *() {
    this.timeout(20000);
    bitgo = new TestV2BitGo({ env: 'test' });
    bitgo.initializeTestVars();
    basecoin = bitgo.coin('tbtc');
    basecoin.keychains();

    nock.cleanAll();
    nock.enableNetConnect();
    yield bitgo.authenticateTestUser(bitgo.testUserOTP());

    const minBalance = 0.1e8;
    consolidationWallet = yield getWalletWithMinBalance(bitgo, TestV2BitGo.V2.TEST_WALLET2_UNSPENTS_ID, minBalance);
    sweep1Wallet = yield getWalletWithMinBalance(bitgo, TestV2BitGo.V2.TEST_SWEEP1_ID, minBalance);
    sweep2Wallet = yield getWalletWithMinBalance(bitgo, TestV2BitGo.V2.TEST_SWEEP2_ID, minBalance);

    yield bitgo.unlock({ otp: bitgo.testUserOTP() });
  }));

  it('should consolidate the number of unspents to 2', co(function *() {
    this.timeout(60000);

    const { unspents } = yield consolidationWallet.unspents();
    if (unspents.length < 10) {
      // the fanout test should take care of this
      return this.skip(`not enough unspents to run this test`);
    }

    const params = {
      limit: 250,
      numUnspentsToMake: 2,
      minValue: 1000,
      numBlocks: 12,
      walletPassphrase: TestV2BitGo.V2.TEST_WALLET2_UNSPENTS_PASSCODE
    };
    const transaction = yield consolidationWallet.consolidateUnspents(params);
    transaction.should.have.property('status');
    transaction.should.have.property('txid');
    transaction.status.should.equal('signed');

    yield wait(8);
  }));

  it('should fanout the number of unspents to 200', co(function *() {
    this.timeout(60000);

    {
      const { unspents } = yield consolidationWallet.unspents({ limit: 1000 });
      unspents.length.should.equal(2);
      yield wait(6);
    }

    {
      const params = {
        minHeight: 1,
        maxNumInputsToUse: 80, // should be 2, but if a test were to fail and need to be rerun we want to use more of them
        numUnspentsToMake: 20,
        numBlocks: 12,
        walletPassphrase: TestV2BitGo.V2.TEST_WALLET2_UNSPENTS_PASSCODE
      };

      const transaction = yield consolidationWallet.fanoutUnspents(params);
      transaction.should.have.property('status');
      transaction.should.have.property('txid');
      transaction.status.should.equal('signed');
      yield wait(8);
      const { unspents } = yield consolidationWallet.unspents({ limit: 1000 });
      unspents.length.should.equal(20);
    }
  }));

  // TODO: change xit to it once the sweepWallet route is running on test, to run this integration test
  it('should sweep funds between two wallets', co(function *() {
    this.timeout(60000);

    {
      const params = {
        address: TestV2BitGo.V2.TEST_SWEEP2_ADDRESS,
        walletPassphrase: TestV2BitGo.V2.TEST_SWEEP1_PASSCODE
      };
      const transaction = yield sweep1Wallet.sweep(params);
      transaction.should.have.property('status');
      transaction.should.have.property('txid');
      transaction.status.should.equal('signed');

      yield wait(8);

      const { unspents: unspentsWallet1 } = yield sweep1Wallet.unspents();
      unspentsWallet1.length.should.equal(0);

      const { unspents: unspentsWallet2 } = yield sweep2Wallet.unspents();
      unspentsWallet2.length.should.greaterThanOrEqual(1);
    }

    {
      // sweep funds back to starting wallet
      const params = {
        address: TestV2BitGo.V2.TEST_SWEEP1_ADDRESS,
        walletPassphrase: TestV2BitGo.V2.TEST_SWEEP2_PASSCODE
      };
      const transaction = yield consolidationWallet.sweep(params);

      transaction.should.have.property('status');
      transaction.should.have.property('txid');
      transaction.status.should.equal('signed');

      yield wait(8);

      const { unspents: unspentsWallet2 } = yield sweep2Wallet.unspents();
      unspentsWallet2.length.should.equal(0);
      const { unspents: unspentsWallet1 } = yield sweep1Wallet.unspents();
      unspentsWallet1.length.should.equal(1);
    }
  }));
});
