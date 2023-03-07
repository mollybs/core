const { contract, ethers } = require('hardhat')
const { itParam } = require('mocha-param')

const { StETH, shareRate, e18, e27, toBN } = require('../helpers/utils')
const { assert } = require('../helpers/assert')
const { MAX_UINT256 } = require('../helpers/constants')
const { EvmSnapshot } = require('../helpers/blockchain')

const { deployWithdrawalQueue } = require('./withdrawal-queue-deploy.test')

contract('WithdrawalQueue', ([owner, stranger, daoAgent, user, pauser, resumer, oracle, anotherUser]) => {
  let withdrawalQueue, steth

  const snapshot = new EvmSnapshot(ethers.provider)

  let rebaseCounter = 0
  const setShareRate = async (rate) => {
    const totalShares = await steth.getTotalShares()
    await withdrawalQueue.onOracleReport(false, rebaseCounter, ++rebaseCounter, { from: daoAgent })
    await steth.setTotalPooledEther(totalShares.mul(toBN(e18(rate))).div(toBN(e18(1))))
  }

  const finalizeRequests = async ({ finalizationShareRate, maxTimeStamp, budget, expectedBatches }) => {
    const calculatedBatches = await withdrawalQueue.calculateFinalizationBatches(finalizationShareRate, maxTimeStamp, [
      budget,
      false,
      [],
    ])

    assert.isTrue(calculatedBatches.finished)
    assert.equalsDelta(calculatedBatches.ethBudget, 0, 2)
    assert.equals(calculatedBatches.batches, expectedBatches)

    const batch = await withdrawalQueue.prefinalize.call(calculatedBatches.batches, finalizationShareRate)

    assert.equalsDelta(batch.ethToLock, budget, 2)

    await withdrawalQueue.finalize(calculatedBatches.batches, finalizationShareRate, {
      from: daoAgent,
      value: batch.ethToLock,
    })

    return { batch }
  }

  before('Deploy', async () => {
    const deployed = await deployWithdrawalQueue({
      stethOwner: owner,
      queueAdmin: daoAgent,
      queuePauser: daoAgent,
      queueResumer: daoAgent,
      queueFinalizer: daoAgent,
      queueOracle: daoAgent,
    })

    steth = deployed.steth
    withdrawalQueue = deployed.withdrawalQueue

    await steth.mintShares(user, e18(10))
    await steth.approve(withdrawalQueue.address, StETH(10), { from: user })
    await steth.mintShares(anotherUser, e18(10))
    await steth.approve(withdrawalQueue.address, StETH(10), { from: anotherUser })

    await setShareRate(1)
    await snapshot.make()
  })

  afterEach(async () => {
    await snapshot.rollback()
  })

  context('1 request', () => {
    itParam('same rate ', [0.25, 0.5, 1], async (postFinalizationRate) => {
      const finalizationShareRate = shareRate(1)
      const userRequestAmount = e18(1)

      await withdrawalQueue.requestWithdrawals([userRequestAmount], user, { from: user })
      assert.equals(await withdrawalQueue.unfinalizedStETH(), userRequestAmount)
      assert.equals(await withdrawalQueue.balanceOf(user), 1)

      await finalizeRequests({
        finalizationShareRate,
        maxTimeStamp: MAX_UINT256,
        budget: userRequestAmount,
        expectedBatches: [1],
      })

      assert.equals(await withdrawalQueue.unfinalizedStETH(), 0)
      assert.equals(await withdrawalQueue.balanceOf(user), 1)

      await setShareRate(postFinalizationRate)

      const userBalanceBefore = await ethers.provider.getBalance(user)
      await withdrawalQueue.claimWithdrawal(1, { from: user })
      assert.equals(await ethers.provider.getBalance(user), userBalanceBefore.add(userRequestAmount))

      assert.equals(await ethers.provider.getBalance(withdrawalQueue.address), 0)
    })

    itParam('finalization rate is lower', [0.25, 0.5, 1, 2], async (postFinalizationRate) => {
      const finalizationShareRate = shareRate(0.5)
      const userRequestAmount = e18(1)
      const budget = toBN(userRequestAmount).div(toBN(2)).toString()

      await withdrawalQueue.requestWithdrawals([userRequestAmount], user, { from: user })
      assert.equals(await withdrawalQueue.unfinalizedStETH(), userRequestAmount)
      assert.equals(await withdrawalQueue.balanceOf(user), 1)

      await setShareRate(0.5)

      await finalizeRequests({
        finalizationShareRate,
        maxTimeStamp: MAX_UINT256,
        budget,
        expectedBatches: [1],
      })

      assert.equals(await withdrawalQueue.unfinalizedStETH(), 0)
      assert.equals(await withdrawalQueue.balanceOf(user), 1)

      await setShareRate(postFinalizationRate)

      const userBalanceBefore = await ethers.provider.getBalance(user)
      await withdrawalQueue.claimWithdrawal(1, { from: user })
      assert.equals(await ethers.provider.getBalance(user), userBalanceBefore.add(e18(0.5)))

      assert.equals(await ethers.provider.getBalance(withdrawalQueue.address), 0)
    })

    itParam('finalization rate is higher', [0.25, 0.5, 1, 2, 4], async (postFinalizationRate) => {
      const finalizationShareRate = shareRate(2)
      const userRequestAmount = e18(1)

      await withdrawalQueue.requestWithdrawals([userRequestAmount], user, { from: user })
      assert.equals(await withdrawalQueue.unfinalizedStETH(), userRequestAmount)
      assert.equals(await withdrawalQueue.balanceOf(user), 1)

      await setShareRate(2)

      await finalizeRequests({
        finalizationShareRate,
        maxTimeStamp: MAX_UINT256,
        budget: userRequestAmount,
        expectedBatches: [1],
      })

      assert.equals(await withdrawalQueue.unfinalizedStETH(), 0)
      assert.equals(await withdrawalQueue.balanceOf(user), 1)

      await setShareRate(postFinalizationRate)

      const userBalanceBefore = await ethers.provider.getBalance(user)
      await withdrawalQueue.claimWithdrawal(1, { from: user })
      assert.equals(await ethers.provider.getBalance(user), userBalanceBefore.add(e18(1)))

      assert.equals(await ethers.provider.getBalance(withdrawalQueue.address), 0)
    })
  })

  context('2 users, 1 batch', () => {
    ;[0.7].forEach(async (firstRequestRate) => {
      ;[0.4, 0.7, 1].forEach(async (secondRequestRate) => {
        ;[firstRequestRate, secondRequestRate, secondRequestRate - 0.1, secondRequestRate + 0.1].forEach(
          async (finalizationRate) => {
            ;[
              firstRequestRate,
              firstRequestRate - 0.1,
              firstRequestRate + 0.1,
              secondRequestRate,
              finalizationRate,
              finalizationRate - 0.1,
              finalizationRate + 0.1,
            ].forEach(async (postFinalizationRate) => {
              it(`rates: first request = ${firstRequestRate}, second request = ${secondRequestRate}, finalization = ${finalizationRate}, claim = ${postFinalizationRate}`, async () => {
                await setShareRate(firstRequestRate)
                const userRequestAmount = e18(1)
                await withdrawalQueue.requestWithdrawals([userRequestAmount], user, { from: user })

                assert.equals(await withdrawalQueue.unfinalizedStETH(), userRequestAmount)
                assert.equals(await withdrawalQueue.balanceOf(user), 1)
                assert.equals(await withdrawalQueue.balanceOf(anotherUser), 0)

                await setShareRate(secondRequestRate)
                const anotherUserRequestAmount = e18(2)
                await withdrawalQueue.requestWithdrawals([anotherUserRequestAmount], anotherUser, { from: anotherUser })

                const userExpectedEthAmount =
                  finalizationRate >= firstRequestRate
                    ? toBN(userRequestAmount)
                    : toBN(userRequestAmount)
                        .mul(toBN(e27(finalizationRate)))
                        .div(toBN(e27(firstRequestRate)))

                const anotherUserExpectedEthAmount =
                  finalizationRate >= secondRequestRate
                    ? toBN(anotherUserRequestAmount)
                    : toBN(anotherUserRequestAmount)
                        .mul(toBN(e27(finalizationRate)))
                        .div(toBN(e27(secondRequestRate)))

                const totalRequestedAmount = userExpectedEthAmount.add(anotherUserExpectedEthAmount)

                const stETHRequested = toBN(userRequestAmount).add(toBN(anotherUserRequestAmount))

                assert.equals(await withdrawalQueue.unfinalizedStETH(), stETHRequested)
                assert.equals(await withdrawalQueue.balanceOf(user), 1)
                assert.equals(await withdrawalQueue.balanceOf(anotherUser), 1)

                await setShareRate(finalizationRate)

                let expectedBatches =
                  (firstRequestRate <= finalizationRate && secondRequestRate <= finalizationRate) ||
                  (firstRequestRate > finalizationRate && secondRequestRate > finalizationRate)
                    ? [2]
                    : [1, 2]

                // handling math accuracy
                if (firstRequestRate === finalizationRate && secondRequestRate > finalizationRate) {
                  expectedBatches = [2]
                } else if (firstRequestRate === finalizationRate && secondRequestRate < finalizationRate) {
                  expectedBatches = [1, 2]
                }

                await finalizeRequests({
                  finalizationShareRate: shareRate(finalizationRate),
                  maxTimeStamp: MAX_UINT256,
                  budget: totalRequestedAmount,
                  expectedBatches,
                })

                assert.equals(await withdrawalQueue.unfinalizedStETH(), 0)
                assert.equals(await withdrawalQueue.balanceOf(user), 1)
                assert.equals(await withdrawalQueue.balanceOf(anotherUser), 1)

                await setShareRate(postFinalizationRate)

                const userBalanceBefore = await ethers.provider.getBalance(user)
                await withdrawalQueue.claimWithdrawal(1, { from: user })
                assert.equalsDelta(
                  await ethers.provider.getBalance(user),
                  toBN(userBalanceBefore).add(userExpectedEthAmount),
                  1
                )

                const anotherUserBalanceBefore = await ethers.provider.getBalance(anotherUser)
                await withdrawalQueue.claimWithdrawal(2, { from: anotherUser })
                assert.equalsDelta(
                  await ethers.provider.getBalance(anotherUser),
                  toBN(anotherUserBalanceBefore).add(anotherUserExpectedEthAmount),
                  1
                )

                assert.equalsDelta(await ethers.provider.getBalance(withdrawalQueue.address), 0, 2)
              })
            })
          }
        )
      })
    })
  })

  context('2 users, 2 batch', () => {
    ;[0.7].forEach(async (firstRequestRate) => {
      ;[0.4, 0.7, 1].forEach(async (secondRequestRate) => {
        ;[firstRequestRate, secondRequestRate, secondRequestRate - 0.1, secondRequestRate + 0.1].forEach(
          async (firstFinalizationRate) => {
            ;[firstRequestRate, secondRequestRate, secondRequestRate - 0.1, secondRequestRate + 0.1].forEach(
              async (secondFinalizationRate) => {
                ;[
                  firstRequestRate,
                  firstRequestRate - 0.1,
                  firstRequestRate + 0.1,
                  secondRequestRate,
                  firstFinalizationRate,
                  firstFinalizationRate - 0.1,
                  firstFinalizationRate + 0.1,
                  secondFinalizationRate,
                ].forEach(async (postFinalizationRate) => {
                  it(`rates: first request = ${firstRequestRate}, second request = ${secondRequestRate}, secondFinalizationRate = ${secondFinalizationRate}, firstFinalization = ${firstFinalizationRate}, claim = ${postFinalizationRate}`, async () => {
                    await setShareRate(firstRequestRate)
                    const userRequestAmount = e18(1)
                    await withdrawalQueue.requestWithdrawals([userRequestAmount], user, { from: user })

                    assert.equals(await withdrawalQueue.unfinalizedStETH(), userRequestAmount)
                    assert.equals(await withdrawalQueue.balanceOf(user), 1)
                    assert.equals(await withdrawalQueue.balanceOf(anotherUser), 0)

                    await setShareRate(secondRequestRate)
                    const anotherUserRequestAmount = e18(2)
                    await withdrawalQueue.requestWithdrawals([anotherUserRequestAmount], anotherUser, {
                      from: anotherUser,
                    })

                    assert.equals(
                      await withdrawalQueue.unfinalizedStETH(),
                      toBN(userRequestAmount).add(toBN(anotherUserRequestAmount))
                    )
                    assert.equals(await withdrawalQueue.balanceOf(user), 1)
                    assert.equals(await withdrawalQueue.balanceOf(anotherUser), 1)

                    const userExpectedEthAmount =
                      firstFinalizationRate >= firstRequestRate
                        ? toBN(userRequestAmount)
                        : toBN(userRequestAmount)
                            .mul(toBN(e27(firstFinalizationRate)))
                            .div(toBN(e27(firstRequestRate)))

                    const anotherUserExpectedEthAmount =
                      secondFinalizationRate >= secondRequestRate
                        ? toBN(anotherUserRequestAmount)
                        : toBN(anotherUserRequestAmount)
                            .mul(toBN(e27(secondFinalizationRate)))
                            .div(toBN(e27(secondRequestRate)))

                    const stETHRequested = toBN(userRequestAmount).add(toBN(anotherUserRequestAmount))

                    assert.equals(await withdrawalQueue.unfinalizedStETH(), stETHRequested)
                    assert.equals(await withdrawalQueue.balanceOf(user), 1)
                    assert.equals(await withdrawalQueue.balanceOf(anotherUser), 1)

                    await setShareRate(firstFinalizationRate)

                    await finalizeRequests({
                      finalizationShareRate: shareRate(firstFinalizationRate),
                      maxTimeStamp: MAX_UINT256,
                      budget: userExpectedEthAmount,
                      expectedBatches: [1],
                    })

                    await setShareRate(secondFinalizationRate)

                    await finalizeRequests({
                      finalizationShareRate: shareRate(secondFinalizationRate),
                      maxTimeStamp: MAX_UINT256,
                      budget: anotherUserExpectedEthAmount,
                      expectedBatches: [2],
                    })

                    await setShareRate(postFinalizationRate)

                    const userBalanceBefore = await ethers.provider.getBalance(user)
                    await withdrawalQueue.claimWithdrawal(1, { from: user })
                    assert.equalsDelta(
                      await ethers.provider.getBalance(user),
                      toBN(userBalanceBefore).add(userExpectedEthAmount),
                      1
                    )

                    const anotherUserBalanceBefore = await ethers.provider.getBalance(anotherUser)
                    await withdrawalQueue.claimWithdrawal(2, { from: anotherUser })
                    assert.equalsDelta(
                      await ethers.provider.getBalance(anotherUser),
                      toBN(anotherUserBalanceBefore).add(anotherUserExpectedEthAmount),
                      1
                    )

                    assert.equalsDelta(await ethers.provider.getBalance(withdrawalQueue.address), 0, 2)
                  })
                })
              }
            )
          }
        )
      })
    })
  })
})
