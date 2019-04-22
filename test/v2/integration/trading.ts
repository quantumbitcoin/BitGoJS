import { coroutine as co } from 'bluebird';
import should = require('should');

const TestV2BitGo = require('../../lib/test_bitgo');

describe('V2 Trading', function() {
  let bitgo;
  let basecoin;
  let wallets;
  let wallet;
  let trading;

  before(co(function *() {
    bitgo = new TestV2BitGo({ env: 'dev' });
    bitgo.initializeTestVars();
    basecoin = bitgo.coin('ofc');
    wallets = basecoin.wallets();
    basecoin.keychains();

    yield bitgo.authenticateOfcTestUser(bitgo.testUserOTP());
    wallet = yield wallets.getWallet({ id: bitgo.V2.OFC_TEST_WALLET_ID });
    trading = wallet.trading();
  }));

  it('should create and sign a trade payload', co(function *() {
    const { payload, signature } = yield trading.signTradePayload({
      currency: 'btc',
      amount: '100000000',
      otherParties: ['test_counterparty_1'],
      walletPassphrase: bitgo.OFC_TEST_PASSWORD
    });

    console.log('======= PAYLOAD ========\n' + payload);
    console.log('======= SIGNATURE =========\n' + signature);

    should.exist(payload);
    // The payload should be a valid JSON object
    // NOTE: we shouldn't do any more validation than this, as the schema is subject to change rapidly
    (() => { JSON.parse(payload); }).should.not.throw();

    should.exist(signature);
  }));
});
