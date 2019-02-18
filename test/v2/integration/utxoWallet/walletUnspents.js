//
// Tests for Wallets
//

const Promise = require('bluebird');
const co = Promise.coroutine;

const TestV2BitGo = require('../../../lib/test_bitgo');

describe('Unspent Manipulation', function() {
  let bitgo;
  // eslint-disable-next-line
  let wallet;
  let wallets;
  let basecoin;

  // TODO: automate keeping test wallet full with bitcoin
  // If failures are occurring, make sure that the wallet at test.bitgo.com contains bitcoin.
  // The wallet is named Test Wallet, and its information is sometimes cleared from the test environment, causing
  // many of these tests to fail. If that is the case, send it some bitcoin with at least 2 transactions
  // to make sure the tests will pass.

  before(co(function *() {
    bitgo = new TestV2BitGo({ env: 'test' });
    bitgo.initializeTestVars();
    basecoin = bitgo.coin('tbtc');
    wallets = basecoin.wallets();
    basecoin.keychains();

    yield bitgo.authenticateTestUser(bitgo.testUserOTP());
    wallet = yield wallets.getWallet({ id: TestV2BitGo.V2.TEST_WALLET1_ID });

    const fundingVerificationBitgo = new TestV2BitGo({ env: 'test' });
    fundingVerificationBitgo.initializeTestVars();
    yield fundingVerificationBitgo.checkFunded();
  }));

  xit('should consolidate the number of unspents to 2, and fanout the number of unspents to 200', co(function *() {
    const unspentWallet = yield wallets.getWallet({ id: TestV2BitGo.V2.TEST_WALLET2_UNSPENTS_ID });
    yield bitgo.unlock({ otp: bitgo.testUserOTP() });
    yield Promise.delay(3000);

    const params1 = {
      limit: 250,
      numUnspentsToMake: 2,
      minValue: 1000,
      numBlocks: 12,
      walletPassphrase: TestV2BitGo.V2.TEST_WALLET2_UNSPENTS_PASSCODE
    };
    const transaction1 = yield unspentWallet.consolidateUnspents(params1);
    transaction1.should.have.property('status');
    transaction1.should.have.property('txid');
    transaction1.status.should.equal('signed');

    yield Promise.delay(8000);

    const unspentsResult1 = yield unspentWallet.unspents({ limit: 1000 });
    const numUnspents1 = unspentsResult1.unspents.length;
    numUnspents1.should.equal(2);

    yield Promise.delay(6000);

    const params2 = {
      minHeight: 1,
      maxNumInputsToUse: 80, // should be 2, but if a test were to fail and need to be rerun we want to use more of them
      numUnspentsToMake: 20,
      numBlocks: 12,
      walletPassphrase: TestV2BitGo.V2.TEST_WALLET2_UNSPENTS_PASSCODE
    };
    const transaction2 = yield unspentWallet.fanoutUnspents(params2);

    transaction2.should.have.property('status');
    transaction2.should.have.property('txid');
    transaction2.status.should.equal('signed');

    yield Promise.delay(8000);

    const unspentsResult2 = yield unspentWallet.unspents({ limit: 1000 });
    const numUnspents2 = unspentsResult2.unspents.length;
    numUnspents2.should.equal(20);
  }));

  // TODO: change xit to it once the sweepWallet route is running on test, to run this integration test
  xit('should sweep funds between two wallets', co(function *() {
    const unspentWallet = yield wallets.getWallet({ id: TestV2BitGo.V2.TEST_WALLET2_UNSPENTS_ID });
    const sweep1Wallet = yield wallets.getWallet({ id: TestV2BitGo.V2.TEST_SWEEP1_ID });
    const sweep2Wallet = yield wallets.getWallet({ id: TestV2BitGo.V2.TEST_SWEEP2_ID });
    yield bitgo.unlock({ otp: bitgo.testUserOTP() });
    yield Promise.delay(3000);

    const params1 = {
      address: TestV2BitGo.V2.TEST_SWEEP2_ADDRESS,
      walletPassphrase: TestV2BitGo.V2.TEST_SWEEP1_PASSCODE
    };
    const transaction1 = yield sweep1Wallet.sweep(params1);
    transaction1.should.have.property('status');
    transaction1.should.have.property('txid');
    transaction1.status.should.equal('signed');

    yield Promise.delay(8000);

    const unspentsResult1 = yield sweep1Wallet.unspents();
    const numUnspents1 = unspentsResult1.unspents.length;
    numUnspents1.should.equal(0);

    const unspentsResult2 = yield sweep2Wallet.unspents();
    const numUnspents2 = unspentsResult2.unspents.length;
    numUnspents2.should.equal(1);

    // sweep funds back to starting wallet
    const params2 = {
      address: TestV2BitGo.V2.TEST_SWEEP1_ADDRESS,
      walletPassphrase: TestV2BitGo.V2.TEST_SWEEP2_PASSCODE
    };
    const transaction2 = yield unspentWallet.sweep(params2);

    transaction2.should.have.property('status');
    transaction2.should.have.property('txid');
    transaction2.status.should.equal('signed');

    yield Promise.delay(8000);

    const unspentsResult3 = yield sweep2Wallet.unspents();
    const numUnspents3 = unspentsResult3.unspents.length;
    numUnspents3.should.equal(0);

    const unspentsResult4 = yield sweep1Wallet.unspents();
    const numUnspents4 = unspentsResult4.unspents.length;
    numUnspents4.should.equal(1);
  }));
});
