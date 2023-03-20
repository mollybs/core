const { artifacts, contract, ethers } = require('hardhat')

const { bn, MAX_UINT64 } = require('@aragon/contract-helpers-test')
const { EvmSnapshot } = require('../helpers/blockchain')
const { ETH } = require('../helpers/utils')
const { assert } = require('../helpers/assert')

const PositiveTokenRebaseLimiter = artifacts.require('PositiveTokenRebaseLimiterMock.sol')
const UNLIMITED_REBASE = bn(MAX_UINT64)
const e9 = bn('10').pow(bn('9'))

contract('PositiveTokenRebaseLimiter', () => {
  let limiter, snapshot

  before('deploy mock', async () => {
    limiter = await PositiveTokenRebaseLimiter.new()

    snapshot = new EvmSnapshot(ethers.provider)
    await snapshot.make()
  })

  afterEach(async () => {
    await snapshot.rollback()
  })

  it('check uninitialized state', async () => {
    const limiterValues = await limiter.getLimiterValues()

    assert.equals(limiterValues.preTotalPooledEther, 0)
    assert.equals(limiterValues.preTotalShares, 0)
    assert.equals(limiterValues.postTotalPooledEther, 0)
    assert.equals(limiterValues.rebaseLimit, 0)

    assert.isTrue(await limiter.isLimitReached())
  })

  it('initialization check', async () => {
    const rebaseLimit = UNLIMITED_REBASE.div(bn(10))
    const preTotalPooledEther = ETH(101)
    const preTotalShares = ETH(75)
    await limiter.initLimiterState(rebaseLimit, preTotalPooledEther, preTotalShares)

    const limiterValues = await limiter.getLimiterValues()

    assert.equals(limiterValues.preTotalPooledEther, preTotalPooledEther)
    assert.equals(limiterValues.preTotalShares, preTotalShares)
    assert.equals(limiterValues.postTotalPooledEther, preTotalPooledEther)
    assert.equals(limiterValues.rebaseLimit, rebaseLimit)
    assert.isFalse(await limiter.isLimitReached())

    await assert.revertsWithCustomError(
      limiter.initLimiterState(ETH(0), preTotalPooledEther, preTotalShares),
      'TooLowTokenRebaseLimit()'
    )
    await assert.revertsWithCustomError(
      limiter.initLimiterState(UNLIMITED_REBASE.add(bn(1)), preTotalPooledEther, preTotalShares),
      'TooHighTokenRebaseLimit()'
    )

    await limiter.initLimiterState(UNLIMITED_REBASE, preTotalPooledEther, preTotalShares)
  })

  it('raise limit', async () => {
    const rebaseLimit = bn('7500')
    const preTotalPooledEther = ETH(101)
    const preTotalShares = ETH(75)
    await limiter.initLimiterState(rebaseLimit, preTotalPooledEther, preTotalShares)

    await limiter.raiseLimit(ETH(0))
    const limiterValues0 = await limiter.getLimiterValues()
    assert.equals(limiterValues0.preTotalPooledEther, preTotalPooledEther)
    assert.equals(limiterValues0.preTotalShares, preTotalShares)
    assert.equals(limiterValues0.postTotalPooledEther, preTotalPooledEther)
    assert.equals(limiterValues0.rebaseLimit, rebaseLimit)
    assert.isFalse(await limiter.isLimitReached())

    await limiter.raiseLimit(ETH(1))
    const limiterValuesNeg = await limiter.getLimiterValues()
    assert.equals(limiterValuesNeg.preTotalPooledEther, preTotalPooledEther)
    assert.equals(limiterValuesNeg.preTotalShares, preTotalShares)
    assert.equals(limiterValuesNeg.rebaseLimit, rebaseLimit)
    assert.equals(limiterValuesNeg.postTotalPooledEther, bn(preTotalPooledEther).sub(bn(ETH(1))))
    assert.isFalse(await limiter.isLimitReached())
  })

  it('consume limit', async () => {
    const rebaseLimit = bn('7500')
    const preTotalPooledEther = ETH(1000000)
    const preTotalShares = ETH(750)
    await limiter.initLimiterState(rebaseLimit, preTotalPooledEther, preTotalShares)

    await limiter.consumeLimit(ETH(1))
    assert.isFalse(await limiter.isLimitReached())

    const limiterValues = await limiter.getLimiterValues()
    assert.equals(limiterValues.preTotalPooledEther, preTotalPooledEther)
    assert.equals(limiterValues.preTotalShares, preTotalShares)
    assert.equals(limiterValues.postTotalPooledEther, bn(preTotalPooledEther).add(bn(ETH(1))))
    assert.equals(limiterValues.rebaseLimit, rebaseLimit)
    assert.isFalse(await limiter.isLimitReached())

    const tx = await limiter.consumeLimit(ETH(2))
    assert.emits(tx, 'ReturnValue', { retValue: ETH(2) })
    assert.isFalse(await limiter.isLimitReached())

    const tx2 = await limiter.consumeLimit(ETH(4))
    assert.emits(tx2, 'ReturnValue', { retValue: ETH(4) })
    assert.isFalse(await limiter.isLimitReached())

    const tx3 = await limiter.consumeLimit(ETH(1))
    assert.emits(tx3, 'ReturnValue', { retValue: ETH(0.5) })
    assert.isTrue(await limiter.isLimitReached())
    assert.equals(await limiter.getSharesToBurnLimit(), 0)
  })

  it('raise and consume', async () => {
    const rebaseLimit = bn('5000')
    const preTotalPooledEther = ETH(2000000)
    const preTotalShares = ETH(1000000)
    await limiter.initLimiterState(rebaseLimit, preTotalPooledEther, preTotalShares)

    await limiter.raiseLimit(ETH(1))
    assert.isFalse(await limiter.isLimitReached())

    const tx = await limiter.consumeLimit(ETH(2))
    assert.emits(tx, 'ReturnValue', { retValue: ETH(2) })

    assert.isFalse(await limiter.isLimitReached())
    const limiterValues = await limiter.getLimiterValues()

    assert.equals(limiterValues.preTotalPooledEther, preTotalPooledEther)
    assert.equals(limiterValues.preTotalShares, preTotalShares)
    assert.equals(limiterValues.postTotalPooledEther, bn(preTotalPooledEther).add(bn(ETH(2 - 1))))
    assert.equals(limiterValues.rebaseLimit, rebaseLimit)

    assert.equals(await limiter.getSharesToBurnLimit(), bn('4499977500112499437'))

    const preShareRate = bn(preTotalPooledEther).mul(e9).div(bn(preTotalShares))
    const postShareRate = bn(limiterValues.postTotalPooledEther)
      .mul(e9)
      .div(bn(preTotalShares).sub(await limiter.getSharesToBurnLimit()))

    const rebase = e9.mul(postShareRate).div(preShareRate).sub(e9)
    assert.almostEqual(rebase, rebaseLimit, 1)
  })

  it('raise, consume, and raise again', async () => {
    const rebaseLimit = bn('5000')
    const preTotalPooledEther = ETH(2000000)
    const preTotalShares = ETH(1000000)
    await limiter.initLimiterState(rebaseLimit, preTotalPooledEther, preTotalShares)

    await limiter.raiseLimit(ETH(1))
    assert.isFalse(await limiter.isLimitReached())

    const tx = await limiter.consumeLimit(ETH(2))
    assert.emits(tx, 'ReturnValue', { retValue: ETH(2) })

    assert.isFalse(await limiter.isLimitReached())
    let limiterValues = await limiter.getLimiterValues()

    assert.equals(limiterValues.preTotalPooledEther, preTotalPooledEther)
    assert.equals(limiterValues.preTotalShares, preTotalShares)
    assert.equals(limiterValues.postTotalPooledEther, bn(preTotalPooledEther).add(bn(ETH(2 - 1))))
    assert.equals(limiterValues.rebaseLimit, rebaseLimit)

    await limiter.raiseLimit(ETH(1))
    assert.isFalse(await limiter.isLimitReached())
    limiterValues = await limiter.getLimiterValues()

    assert.equals(limiterValues.preTotalPooledEther, preTotalPooledEther)
    assert.equals(limiterValues.preTotalShares, preTotalShares)
    assert.equals(limiterValues.postTotalPooledEther, preTotalPooledEther)
    assert.equals(limiterValues.rebaseLimit, rebaseLimit)

    assert.equals(await limiter.getSharesToBurnLimit(), bn('4999975000124999375'))
  })

  it('zero tvl no reverts (means unlimited)', async () => {
    const rebaseLimit = bn('5000')
    const preTotalPooledEther = ETH(0)
    const preTotalShares = ETH(0)

    await limiter.initLimiterState(rebaseLimit, preTotalPooledEther, preTotalShares)
    assert.equals(await limiter.getSharesToBurnLimit(), 0)

    await limiter.raiseLimit(ETH(0))
    assert.isFalse(await limiter.isLimitReached())
    await limiter.consumeLimit(ETH(0))
    assert.isFalse(await limiter.isLimitReached())

    await limiter.raiseLimit(ETH(1))
    assert.isFalse(await limiter.isLimitReached())
    await limiter.consumeLimit(ETH(1))
    assert.isFalse(await limiter.isLimitReached())

    const ethTx = await limiter.consumeLimit(ETH(2))
    assert.isFalse(await limiter.isLimitReached())
    assert.emits(ethTx, 'ReturnValue', { retValue: ETH(2) })

    const maxSharesToBurn = await limiter.getSharesToBurnLimit()
    assert.equals(maxSharesToBurn, 0)
  })

  it('share rate ~1 case with huge withdrawal', async () => {
    const rebaseLimit = bn('1000000') // 0.1%
    const preTotalPooledEther = ETH('1000000')
    const preTotalShares = ETH('1000000')

    await limiter.initLimiterState(rebaseLimit, preTotalPooledEther, preTotalShares)
    await limiter.consumeLimit(ETH(1000))
    await limiter.raiseLimit(ETH(40000)) // withdrawal fulfillment

    assert.isFalse(await limiter.isLimitReached())
    const limiterValues = await limiter.getLimiterValues()

    assert.equals(limiterValues.preTotalPooledEther, preTotalPooledEther)
    assert.equals(limiterValues.preTotalShares, preTotalShares)
    assert.equals(limiterValues.postTotalPooledEther, bn(preTotalPooledEther).sub(bn(ETH(39000))))
    assert.equals(limiterValues.rebaseLimit, rebaseLimit)

    assert.equals(await limiter.getSharesToBurnLimit(), bn('39960039960039960039960'))

    const preShareRate = bn(preTotalPooledEther).mul(e9).div(bn(preTotalShares))
    const postShareRate = bn(limiterValues.postTotalPooledEther)
      .mul(e9)
      .div(bn(preTotalShares).sub(await limiter.getSharesToBurnLimit()))

    const rebase = e9.mul(postShareRate).div(preShareRate).sub(e9)
    assert.almostEqual(rebase, rebaseLimit, 1)
  })
})
