const hre = require('hardhat')
const { assert } = require('../helpers/assert')
const { assertRevert } = require('../helpers/assertThrow')
const { toBN, padRight } = require('../helpers/utils')
const { AragonDAO } = require('./helpers/dao')
const { EvmSnapshot } = require('../helpers/blockchain')
const { ZERO_ADDRESS, getEventAt } = require('@aragon/contract-helpers-test')
const nodeOperators = require('../helpers/node-operators')
const signingKeys = require('../helpers/signing-keys')
const { web3, artifacts } = require('hardhat')
const { getRandomLocatorConfig } = require('../helpers/locator')
const { assertBn } = require('@aragon/contract-helpers-test/src/asserts')

const IStakingModule = artifacts.require('contracts/0.8.9/interfaces/IStakingModule.sol:IStakingModule')
const NodeOperatorsRegistry = artifacts.require('NodeOperatorsRegistryMock')
const SigningKeys = artifacts.require('SigningKeys')
const LidoLocator = artifacts.require('LidoLocator')

const ADDRESS_1 = '0x0000000000000000000000000000000000000001'
const ADDRESS_2 = '0x0000000000000000000000000000000000000002'
const ADDRESS_3 = '0x0000000000000000000000000000000000000003'
const ADDRESS_4 = '0x0000000000000000000000000000000000000005'

const NODE_OPERATORS = [
  {
    name: 'fo o',
    rewardAddress: ADDRESS_1,
    totalSigningKeysCount: 10,
    depositedSigningKeysCount: 5,
    exitedSigningKeysCount: 1,
    vettedSigningKeysCount: 6,
    stuckValidatorsCount: 0,
    refundedValidatorsCount: 0,
    stuckPenaltyEndAt: 0
  },
  {
    name: ' bar',
    rewardAddress: ADDRESS_2,
    totalSigningKeysCount: 15,
    depositedSigningKeysCount: 7,
    exitedSigningKeysCount: 0,
    vettedSigningKeysCount: 10,
    stuckValidatorsCount: 0,
    refundedValidatorsCount: 0,
    stuckPenaltyEndAt: 0
  },
  {
    name: 'deactivated',
    isActive: false,
    rewardAddress: ADDRESS_3,
    totalSigningKeysCount: 10,
    depositedSigningKeysCount: 0,
    exitedSigningKeysCount: 0,
    vettedSigningKeysCount: 5,
    stuckValidatorsCount: 0,
    refundedValidatorsCount: 0,
    stuckPenaltyEndAt: 0
  }
]

// bytes32 0x63757261746564
const CURATED_TYPE = padRight(web3.utils.fromAscii('curated'), 32)

const pad = (hex, bytesLength) => {
  const absentZeroes = bytesLength * 2 + 2 - hex.length
  if (absentZeroes > 0) hex = '0x' + '0'.repeat(absentZeroes) + hex.substr(2)
  return hex
}

const hexConcat = (first, ...rest) => {
  let result = first.startsWith('0x') ? first : '0x' + first
  rest.forEach((item) => {
    result += item.startsWith('0x') ? item.substr(2) : item
  })
  return result
}

const ETH = (value) => web3.utils.toWei(value + '', 'ether')
const StETH = artifacts.require('StETHMock')

contract('NodeOperatorsRegistry', ([appManager, voting, user1, user2, user3, nobody]) => {
  let appBase, app, locator, steth, dao
  const snapshot = new EvmSnapshot(hre.ethers.provider)

  before('deploy base app', async () => {
    // Deploy the app's base contract.
    appBase = await NodeOperatorsRegistry.new()
    steth = await StETH.new()
    const locatorConfig = getRandomLocatorConfig({
      lido: steth.address
    })
    locator = await LidoLocator.new(locatorConfig)

    dao = await AragonDAO.create(appManager)
    app = await dao.newAppInstance({
      name: 'node-operators-registry',
      base: appBase,
      permissions: {
        MANAGE_SIGNING_KEYS: voting,
        MANAGE_NODE_OPERATOR_ROLE: voting,
        SET_NODE_OPERATOR_LIMIT_ROLE: voting,
        STAKING_ROUTER_ROLE: voting
      }
    })

    // grant role to app itself cause it uses solidity's call method to itself
    // inside the testing_requestValidatorsKeysForDeposits() method
    await dao.grantPermission(app.address, app, 'STAKING_ROUTER_ROLE')

    // Instantiate a proxy for the app, using the base contract as its logic implementation.
    // const proxyAddress = await newApp(newDAO.dao, 'node-operators-registry', appBase.address, appManager)
    // app = await NodeOperatorsRegistry.at(proxyAddress)

    await assert.reverts(app.finalizeUpgrade_v2(locator.address, CURATED_TYPE), 'CONTRACT_NOT_INITIALIZED_OR_PETRIFIED')

    // Initialize the app's proxy.
    const tx = await app.initialize(locator.address, CURATED_TYPE)

    // Implementation initializer reverts because initialization block was set to max(uint256)
    // in the Autopetrified base contract
    await assertRevert(appBase.initialize(locator.address, CURATED_TYPE), 'INIT_ALREADY_INITIALIZED')

    const moduleType = await app.getType()
    assert.emits(tx, 'ContractVersionSet', { version: 2 })
    assert.emits(tx, 'LocatorContractSet', { locatorAddress: locator.address })
    assert.emits(tx, 'StakingModuleTypeSet', { moduleType })

    await snapshot.make()
  })

  afterEach(async () => {
    await snapshot.rollback()
  })

  describe('initialize', () => {
    it('sets module type correctly', async () => {
      const moduleType = await app.getType()
      assert.equal(moduleType, CURATED_TYPE)
    })

    it('sets locator correctly', async () => {
      const locatorAddr = await app.getLocator()
      assert.equal(locatorAddr, locator.address)
    })

    it('sets contract version correctly', async () => {
      const contractVersion = await app.getContractVersion()
      assert.equal(contractVersion, 2)
    })

    it('sets hasInitialized() to true', async () => {
      assert.isTrue(await app.hasInitialized())
    })

    it("can't be initialized second time", async () => {
      await assert.reverts(app.initialize(steth.address, CURATED_TYPE), 'INIT_ALREADY_INITIALIZED')
    })

    it('reverts with error "ZERO_ADDRESS" when stETH is zero address', async () => {
      const registry = await dao.newAppInstance({ name: 'new-node-operators-registry', base: appBase })
      await assert.reverts(registry.initialize(ZERO_ADDRESS, CURATED_TYPE), 'ZERO_ADDRESS')
    })

    it('call on implementation reverts with error "INIT_ALREADY_INITIALIZED"', async () => {
      // Implementation initializer reverts because initialization block was set to max(uint256)
      // in the Autopetrified base contract
      await assert.reverts(appBase.initialize(steth.address, CURATED_TYPE), 'INIT_ALREADY_INITIALIZED')
    })
  })

  describe('finalizeUpgrade_v2()', () => {
    beforeEach(async () => {
      // reset version there to test upgrade finalization
      await app.testing_setBaseVersion(0)
    })

    it('fails with PETRIFIED error when called on implementation', async () => {
      await assert.reverts(
        appBase.finalizeUpgrade_v2(locator.address, CURATED_TYPE),
        'CONTRACT_NOT_INITIALIZED_OR_PETRIFIED'
      )
    })

    it('sets correct contract version', async () => {
      await app.finalizeUpgrade_v2(locator.address, CURATED_TYPE)
      assert.equals(await app.getContractVersion(), 2)
    })

    it('reverts with error WRONG_BASE_VERSION when called on already initialized contract', async () => {
      await app.finalizeUpgrade_v2(locator.address, CURATED_TYPE)
      assert.equals(await app.getContractVersion(), 2)
      await assert.reverts(app.finalizeUpgrade_v2(locator.address, CURATED_TYPE), 'UNEXPECTED_CONTRACT_VERSION')
    })

    it('sets total signing keys stats correctly', async () => {
      for (let i = 0; i < NODE_OPERATORS.length; ++i) {
        await app.testing_addNodeOperator(
          NODE_OPERATORS[i].name,
          NODE_OPERATORS[i].rewardAddress,
          NODE_OPERATORS[i].totalSigningKeysCount,
          NODE_OPERATORS[i].vettedSigningKeysCount,
          NODE_OPERATORS[i].depositedSigningKeysCount,
          NODE_OPERATORS[i].exitedSigningKeysCount
        )
        await app.testing_setNodeOperatorLimits(
          i,
          NODE_OPERATORS[i].stuckValidatorsCount,
          NODE_OPERATORS[i].refundedValidatorsCount,
          NODE_OPERATORS[i].stuckPenaltyEndAt
        )

        if (NODE_OPERATORS[i].isActive === false) {
          await app.testing_unsafeDeactivateNodeOperator(i)
        }
      }

      for (let i = 0; i < NODE_OPERATORS.length; ++i) {
        const nodeOperator = await app.getNodeOperator(i, false)
        assert.equal(nodeOperator.totalSigningKeys.toNumber(), NODE_OPERATORS[i].totalSigningKeysCount)
        assert.equal(nodeOperator.stakingLimit.toNumber(), NODE_OPERATORS[i].vettedSigningKeysCount)
        assert.equal(nodeOperator.usedSigningKeys.toNumber(), NODE_OPERATORS[i].depositedSigningKeysCount)
        assert.equal(nodeOperator.stoppedValidators.toNumber(), NODE_OPERATORS[i].exitedSigningKeysCount)

        const nodeOperatorLimits = await app.getNodeOperatorSummary(i)
        assert.equal(nodeOperatorLimits.stuckValidatorsCount.toNumber(), NODE_OPERATORS[i].stuckValidatorsCount)
        assert.equal(nodeOperatorLimits.refundedValidatorsCount.toNumber(), NODE_OPERATORS[i].refundedValidatorsCount)
        assert.equal(nodeOperatorLimits.stuckPenaltyEndTimestamp.toNumber(), NODE_OPERATORS[i].stuckPenaltyEndAt)
      }

      await app.finalizeUpgrade_v2(locator.address, CURATED_TYPE)

      const totalSigningKeysStatsAfter = await app.testing_getTotalSigningKeysStats()

      const totalSigningKeysCount = NODE_OPERATORS.reduce((sum, c) => sum + c.totalSigningKeysCount, 0)
      const vettedSigningKeysCount = NODE_OPERATORS.reduce(
        // deactivated node operators vetted keys count trimmed to deposited keys count
        (sum, c) => sum + (c.isActive === false ? c.depositedSigningKeysCount : c.vettedSigningKeysCount),
        0
      )
      const depositedSigningKeysCount = NODE_OPERATORS.reduce((sum, c) => sum + c.depositedSigningKeysCount, 0)
      const exitedSigningKeysCount = NODE_OPERATORS.reduce((sum, c) => sum + c.exitedSigningKeysCount, 0)

      assert.equal(totalSigningKeysStatsAfter.totalSigningKeysCount.toNumber(), totalSigningKeysCount)
      assert.equal(totalSigningKeysStatsAfter.vettedSigningKeysCount.toNumber(), vettedSigningKeysCount)
      assert.equal(totalSigningKeysStatsAfter.depositedSigningKeysCount.toNumber(), depositedSigningKeysCount)
      assert.equal(totalSigningKeysStatsAfter.exitedSigningKeysCount.toNumber(), exitedSigningKeysCount)
    })

    it("trims vettedSigningKeys if it's greater than totalSigningKeys", async () => {
      const config = {
        name: 'test',
        rewardAddress: ADDRESS_1,
        totalSigningKeysCount: 13,
        vettedSigningKeysCount: 17,
        depositedSigningKeysCount: 7,
        exitedSigningKeysCount: 5,
        stuckValidatorsCount: 0,
        refundedValidatorsCount: 0,
        stuckPenaltyEndAt: 0
      }
      await app.testing_addNodeOperator(
        config.name,
        config.rewardAddress,
        config.totalSigningKeysCount,
        config.vettedSigningKeysCount,
        config.depositedSigningKeysCount,
        config.exitedSigningKeysCount
      )
      const id = (await app.getNodeOperatorsCount()) - 1
      await app.testing_setNodeOperatorLimits(
        id,
        config.stuckValidatorsCount,
        config.refundedValidatorsCount,
        config.stuckPenaltyEndAt
      )

      let nodeOperator = await app.getNodeOperator(0, false)
      assert.equal(nodeOperator.stakingLimit.toNumber(), config.vettedSigningKeysCount)
      assert.equal(nodeOperator.totalSigningKeys.toNumber(), config.totalSigningKeysCount)

      await app.finalizeUpgrade_v2(locator.address, CURATED_TYPE)

      nodeOperator = await app.getNodeOperator(0, false)
      assert.equal(nodeOperator.stakingLimit.toNumber(), config.totalSigningKeysCount)
      assert.equal(nodeOperator.totalSigningKeys.toNumber(), config.totalSigningKeysCount)
    })

    it("trims vettedSigningKeys if it's greater than depositedSigningKeysCount", async () => {
      const config = {
        name: 'test',
        rewardAddress: ADDRESS_1,
        totalSigningKeysCount: 13,
        vettedSigningKeysCount: 4,
        depositedSigningKeysCount: 7,
        exitedSigningKeysCount: 5,
        stuckValidatorsCount: 0,
        refundedValidatorsCount: 0,
        stuckPenaltyEndAt: 0
      }

      await app.testing_addNodeOperator(
        config.name,
        config.rewardAddress,
        config.totalSigningKeysCount,
        config.vettedSigningKeysCount,
        config.depositedSigningKeysCount,
        config.exitedSigningKeysCount
      )
      const id = (await app.getNodeOperatorsCount()) - 1
      await app.testing_setNodeOperatorLimits(
        id,
        config.stuckValidatorsCount,
        config.refundedValidatorsCount,
        config.stuckPenaltyEndAt
      )

      let nodeOperator = await app.getNodeOperator(0, false)
      assert.equal(nodeOperator.stakingLimit.toNumber(), config.vettedSigningKeysCount)
      assert.equal(nodeOperator.totalSigningKeys.toNumber(), config.totalSigningKeysCount)

      await app.finalizeUpgrade_v2(locator.address, CURATED_TYPE)

      nodeOperator = await app.getNodeOperator(0, false)

      assert.equal(nodeOperator.stakingLimit.toNumber(), config.depositedSigningKeysCount)
      assert.equal(nodeOperator.totalSigningKeys.toNumber(), config.totalSigningKeysCount)
    })

    it('emits ContractVersionSet event with correct params', async () => {
      const receipt = await app.finalizeUpgrade_v2(locator.address, CURATED_TYPE)
      assert.emits(receipt, 'ContractVersionSet', { version: 2 })
    })

    it('emits LocatorContractSet event with correct params', async () => {
      const receipt = await app.finalizeUpgrade_v2(locator.address, CURATED_TYPE)
      assert.emits(receipt, 'LocatorContractSet', { locatorAddress: locator.address })
    })

    it('emits StakingModuleTypeSet event with correct params', async () => {
      const receipt = await app.finalizeUpgrade_v2(locator.address, CURATED_TYPE)
      const moduleType = await app.getType()
      assert.emits(receipt, 'StakingModuleTypeSet', { moduleType })
    })

    it('increases keysOpIndex & changes nonce', async () => {
      const [keysOpIndexBefore, nonceBefore] = await Promise.all([app.getKeysOpIndex(), app.getNonce()])
      await app.finalizeUpgrade_v2(locator.address, CURATED_TYPE)
      const [keysOpIndexAfter, nonceAfter] = await Promise.all([app.getKeysOpIndex(), app.getNonce()])
      assert.equals(keysOpIndexAfter, keysOpIndexBefore.toNumber() + 1)
      assert.notEquals(nonceAfter, nonceBefore)
    })

    it('emits KeysOpIndexSet & NonceChanged', async () => {
      const keysOpIndexBefore = await app.getKeysOpIndex()
      const receipt = await app.finalizeUpgrade_v2(locator.address, CURATED_TYPE)
      const nonceAfter = await app.getNonce()
      assert.emits(receipt, 'KeysOpIndexSet', { keysOpIndex: keysOpIndexBefore.toNumber() + 1 })
      assert.emits(receipt, 'NonceChanged', { nonce: nonceAfter })
    })
  })

  describe('addNodeOperator()', () => {
    it('reverts when called by sender without MANAGE_NODE_OPERATOR_ROLE', async () => {
      const hasPermission = await dao.hasPermission(nobody, app, 'MANAGE_NODE_OPERATOR_ROLE')
      assert.isFalse(hasPermission)

      await assert.reverts(app.addNodeOperator('1', ADDRESS_1, { from: nobody }), 'APP_AUTH_FAILED')
    })

    it('reverts with error "WRONG_NAME_LENGTH" when called with empty name', async () => {
      const hasPermission = await dao.hasPermission(voting, app, 'MANAGE_NODE_OPERATOR_ROLE')
      assert.isTrue(hasPermission)

      await assert.reverts(app.addNodeOperator('', ADDRESS_1, { from: voting }), 'WRONG_NAME_LENGTH')
    })

    it('reverts with error "WRONG_NAME_LENGTH" when called with name length > MAX_NODE_OPERATOR_NAME_LENGTH', async () => {
      const hasPermission = await dao.hasPermission(voting, app, 'MANAGE_NODE_OPERATOR_ROLE')
      assert.isTrue(hasPermission)

      const maxNameLength = await app.MAX_NODE_OPERATOR_NAME_LENGTH()
      const tooLongName = '&'.repeat(maxNameLength.toNumber() + 1)

      await assert.reverts(app.addNodeOperator(tooLongName, ADDRESS_1, { from: voting }), 'WRONG_NAME_LENGTH')
    })

    it('reverts with error "ZERO_ADDRESS" when called with zero reward address', async () => {
      const hasPermission = await dao.hasPermission(voting, app, 'MANAGE_NODE_OPERATOR_ROLE')
      assert.isTrue(hasPermission)

      const name = 'Node Operator #1'

      await assert.reverts(app.addNodeOperator(name, ZERO_ADDRESS, { from: voting }), 'ZERO_ADDRESS')
    })

    it('reverts with error "MAX_COUNT_EXCEEDED" when total count of node operators = MAX_COUNT_EXCEEDED', async () => {
      const hasPermission = await dao.hasPermission(voting, app, 'MANAGE_NODE_OPERATOR_ROLE')
      assert.isTrue(hasPermission)

      const maxNodeOperatorsCount = await app.MAX_NODE_OPERATORS_COUNT()

      for (let i = 0; i < maxNodeOperatorsCount; ++i) {
        await app.addNodeOperator(`Node Operator #${i}`, ADDRESS_1, { from: voting })
      }
      assert.equals(await app.getNodeOperatorsCount(), maxNodeOperatorsCount)

      await assert.reverts(app.addNodeOperator(`exceeded`, ADDRESS_2, { from: voting }), 'MAX_OPERATORS_COUNT_EXCEEDED')
    })

    it('creates node operator with correct state', async () => {
      const hasPermission = await dao.hasPermission(voting, app, 'MANAGE_NODE_OPERATOR_ROLE')
      assert.isTrue(hasPermission)

      const name = `Node Operator #1`
      await app.addNodeOperator(name, ADDRESS_1, { from: voting })

      const expectedNodeOperatorId = 0

      const nodeOperator = await app.getNodeOperator(expectedNodeOperatorId, true)

      assert.isTrue(nodeOperator.active)
      assert.equal(nodeOperator.name, name)
      assert.equal(nodeOperator.rewardAddress, ADDRESS_1)
      assert.equal(nodeOperator.stakingLimit, 0)
      assert.equal(nodeOperator.stoppedValidators, 0)
      assert.equal(nodeOperator.totalSigningKeys, 0)
      assert.equal(nodeOperator.usedSigningKeys, 0)
    })

    it('returns correct node operator id', async () => {
      const hasPermission = await dao.hasPermission(voting, app, 'MANAGE_NODE_OPERATOR_ROLE')
      assert.isTrue(hasPermission)

      assert.equals(await app.getNodeOperatorsCount(), 0)

      const name = `Node Operator #1`
      let expectedId = await app.methods['addNodeOperator(string,address)'].call(name, ADDRESS_1, { from: voting })

      assert.equals(expectedId, 0)

      // create node operator to check that next id is correct
      await app.addNodeOperator(name, ADDRESS_1, { from: voting })

      expectedId = await app.methods['addNodeOperator(string,address)'].call(name, ADDRESS_1, { from: voting })
      assert.equals(expectedId, 1)
    })

    it('active & total operators count update correctly', async () => {
      const hasPermission = await dao.hasPermission(voting, app, 'MANAGE_NODE_OPERATOR_ROLE')
      assert.isTrue(hasPermission)

      assert.equals(await app.getNodeOperatorsCount(), 0)
      assert.equals(await app.getActiveNodeOperatorsCount(), 0)

      await app.addNodeOperator(`Node Operator 1`, ADDRESS_1, { from: voting })

      assert.equals(await app.getNodeOperatorsCount(), 1)
      assert.equals(await app.getActiveNodeOperatorsCount(), 1)
    })

    it('emits NodeOperatorAdded events with correct params', async () => {
      const hasPermission = await dao.hasPermission(voting, app, 'MANAGE_NODE_OPERATOR_ROLE')
      assert.isTrue(hasPermission)

      assert.equals(await app.getNodeOperatorsCount(), 0)

      const name = `Node Operator 1`

      const tx = await app.addNodeOperator(name, ADDRESS_1, { from: voting })

      assert.emits(
        tx,
        'NodeOperatorAdded',
        { nodeOperatorId: 0, name, rewardAddress: ADDRESS_1, stakingLimit: 0 },
        { abi: NodeOperatorsRegistry._json.abi }
      )
    })
  })

  describe('activateNodeOperator()', () => {
    beforeEach(async () => {
      await nodeOperators.addNodeOperator(app, NODE_OPERATORS[0], { from: voting })
      await nodeOperators.addNodeOperator(app, NODE_OPERATORS[1], { from: voting })
      await nodeOperators.addNodeOperator(app, NODE_OPERATORS[2], { from: voting })

      const stakingModuleSummary = await app.getStakingModuleSummary()
      assert.equals(stakingModuleSummary.totalExitedValidators, 1)
      assert.equals(stakingModuleSummary.totalDepositedValidators, 12)
      assert.equals(stakingModuleSummary.depositableValidatorsCount, 4)
    })

    it('reverts with APP_AUTH_FAILED error when called by address without MANAGE_NODE_OPERATOR_ROLE permission', async () => {
      const hasPermission = await dao.hasPermission(nobody, app, 'MANAGE_NODE_OPERATOR_ROLE')
      assert.isFalse(hasPermission)
      const nodeOperatorId = 2
      await assert.reverts(app.activateNodeOperator(nodeOperatorId, { from: nobody }), 'APP_AUTH_FAILED')
    })

    it('reverts when called with non-existent operator id', async () => {
      const hasPermission = await dao.hasPermission(voting, app, 'MANAGE_NODE_OPERATOR_ROLE')
      assert.isTrue(hasPermission)
      const nodeOperatorId = Number.MAX_SAFE_INTEGER
      await assert.reverts(app.activateNodeOperator(nodeOperatorId, { from: voting }), 'OUT_OF_RANGE')
    })

    it('reverts with WRONG_OPERATOR_ACTIVE_STATE when called on active node operator', async () => {
      const activeNodeOperatorId = 0

      const activeNodeOperator = await app.getNodeOperator(activeNodeOperatorId, false)
      assert.isTrue(activeNodeOperator.active)

      await assert.reverts(
        app.activateNodeOperator(activeNodeOperatorId, { from: voting }),
        'WRONG_OPERATOR_ACTIVE_STATE'
      )
    })

    it('increases keysOpIndex & changes nonce', async () => {
      const nodeOperatorId = 2
      const [nodeOperator, keysOpIndexBefore, nonceBefore] = await Promise.all([
        app.getNodeOperator(nodeOperatorId, false),
        app.getKeysOpIndex(),
        app.getNonce()
      ])
      assert.isFalse(nodeOperator.active)
      await app.activateNodeOperator(nodeOperatorId, { from: voting })
      const [keysOpIndexAfter, nonceAfter] = await Promise.all([app.getKeysOpIndex(), app.getNonce()])
      assert.equals(keysOpIndexAfter, keysOpIndexBefore.toNumber() + 1)
      assert.notEquals(nonceAfter, nonceBefore)
    })

    it('emits KeysOpIndexSet & NonceChanged', async () => {
      const nodeOperatorId = 2
      const nodeOperator = await app.getNodeOperator(nodeOperatorId, false)
      const keysOpIndexBefore = await app.getKeysOpIndex()
      assert.isFalse(nodeOperator.active)
      const receipt = await app.activateNodeOperator(nodeOperatorId, { from: voting })
      const nonceAfter = await app.getNonce()
      assert.emits(receipt, 'KeysOpIndexSet', { keysOpIndex: keysOpIndexBefore.toNumber() + 1 })
      assert.emits(receipt, 'NonceChanged', { nonce: nonceAfter })
    })

    it('sets active state of node operator to true when it is deactivated', async () => {
      const notActiveNodeOperatorId = 2
      const notActiveNodeOperator = await app.getNodeOperator(notActiveNodeOperatorId, false)

      assert.isFalse(notActiveNodeOperator.active)

      await app.activateNodeOperator(notActiveNodeOperatorId, { from: voting })

      const nodeOperator = await app.getNodeOperator(notActiveNodeOperatorId, false)
      assert.isTrue(nodeOperator.active)
    })

    it('increments active node operators counter', async () => {
      const notActiveNodeOperatorId = 2
      const notActiveNodeOperator = await app.getNodeOperator(notActiveNodeOperatorId, false)

      const activeNodeOperatorsCountBefore = await app.getActiveNodeOperatorsCount()
      assert.isFalse(notActiveNodeOperator.active)
      await app.activateNodeOperator(notActiveNodeOperatorId, { from: voting })

      const activeNodeOperatorsCountAfter = await app.getActiveNodeOperatorsCount()
      assert.equal(activeNodeOperatorsCountAfter.toNumber(), activeNodeOperatorsCountBefore.toNumber() + 1)
    })

    it('emits NodeOperatorActiveSet(activate) event', async () => {
      const nodeOperatorId = await nodeOperators.findNodeOperatorId(app, (operator) => !operator.active)
      assert.notEqual(nodeOperatorId, -1, `Invariant: not active node operator not found`)
      const tx = await app.activateNodeOperator(nodeOperatorId, { from: voting })
      assert.emits(
        tx,
        'NodeOperatorActiveSet',
        { nodeOperatorId, active: true },
        { abi: NodeOperatorsRegistry._json.abi }
      )
    })

    it("doesn't change node operators count", async () => {
      const nodeOperatorsBefore = await nodeOperators.getAllNodeOperators(app)
      const nodeOperatorId = nodeOperatorsBefore.findIndex((operator) => !operator.active)
      assert.notEqual(nodeOperatorId, -1, `Invariant: not active node operator not found`)

      await app.activateNodeOperator(nodeOperatorId, { from: voting })

      const nodeOperatorsAfter = await nodeOperators.getAllNodeOperators(app)

      assert.equal(nodeOperatorsBefore.length, nodeOperatorsAfter.length)
    })

    it("doesn't change other node operators active state", async () => {
      const nodeOperatorsBefore = await nodeOperators.getAllNodeOperators(app)
      const nodeOperatorId = nodeOperatorsBefore.findIndex((operator) => !operator.active)
      assert.notEqual(nodeOperatorId, -1, `Invariant: not active node operator not found`)

      await app.activateNodeOperator(nodeOperatorId, { from: voting })

      const nodeOperatorsAfter = await nodeOperators.getAllNodeOperators(app)

      for (let i = 0; i < nodeOperatorsAfter.length; ++i) {
        if (nodeOperatorId === i) {
          assert.equal(nodeOperatorsBefore[i].active, !nodeOperatorsAfter[i].active)
        } else {
          assert.equal(nodeOperatorsBefore[i].active, nodeOperatorsAfter[i].active)
        }
      }
    })
  })

  describe('deactivateNodeOperator()', async () => {
    beforeEach(async () => {
      await nodeOperators.addNodeOperator(app, NODE_OPERATORS[0], { from: voting })
      await nodeOperators.addNodeOperator(app, NODE_OPERATORS[1], { from: voting })
      await nodeOperators.addNodeOperator(app, NODE_OPERATORS[2], { from: voting })

      const stakingModuleSummary = await app.getStakingModuleSummary()
      assert.equals(stakingModuleSummary.totalExitedValidators, 1)
      assert.equals(stakingModuleSummary.totalDepositedValidators, 12)
      assert.equals(stakingModuleSummary.depositableValidatorsCount, 4)
    })

    it('reverts with "APP_AUTH_FAILED" error when called by address without MANAGE_NODE_OPERATOR_ROLE permission', async () => {
      const hasPermission = await dao.hasPermission(nobody, app, 'MANAGE_NODE_OPERATOR_ROLE')
      assert.isFalse(hasPermission)

      const nodeOperatorId = await nodeOperators.findNodeOperatorId(app, (operator) => !operator.active)
      assert.notEqual(nodeOperatorId, -1, `Invariant: not active node operator not found`)

      await assert.reverts(app.deactivateNodeOperator(nodeOperatorId, { from: nobody }), 'APP_AUTH_FAILED')
    })

    it('reverts with "OUT_OF_RANGE" error when called with non-existent operator id', async () => {
      const hasPermission = await dao.hasPermission(voting, app, 'MANAGE_NODE_OPERATOR_ROLE')
      assert.isTrue(hasPermission)

      const nodeOperatorId = Number.MAX_SAFE_INTEGER

      await assert.reverts(app.deactivateNodeOperator(nodeOperatorId, { from: voting }), 'OUT_OF_RANGE')
    })

    it('reverts with "WRONG_OPERATOR_ACTIVE_STATE" when called on not active node operator', async () => {
      const activeNodeOperatorId = await nodeOperators.findNodeOperatorId(app, (operator) => !operator.active)
      assert.notEqual(activeNodeOperatorId, -1, `Invariant: not active node operator not found`)

      const activeNodeOperator = await app.getNodeOperator(activeNodeOperatorId, false)
      assert.isFalse(activeNodeOperator.active)

      await assert.reverts(
        app.deactivateNodeOperator(activeNodeOperatorId, { from: voting }),
        'WRONG_OPERATOR_ACTIVE_STATE'
      )
    })

    it('sets active state of node operator to false when it is active', async () => {
      const activeNodeOperatorId = await nodeOperators.findNodeOperatorId(app, (operator) => operator.active)
      assert.notEqual(activeNodeOperatorId, -1, `Invariant: active node operator not found`)

      await app.deactivateNodeOperator(activeNodeOperatorId, { from: voting })

      const nodeOperator = await app.getNodeOperator(activeNodeOperatorId, false)
      assert.isFalse(nodeOperator.active)
    })

    it('decrements active node operators counter', async () => {
      const activeNodeOperatorId = await nodeOperators.findNodeOperatorId(app, (operator) => operator.active)
      assert.notEqual(activeNodeOperatorId, -1, `Invariant: active node operator not found`)

      const activeNodeOperatorsCountBefore = await app.getActiveNodeOperatorsCount()

      await app.deactivateNodeOperator(activeNodeOperatorId, { from: voting })

      const activeNodeOperatorsCountAfter = await app.getActiveNodeOperatorsCount()
      assert.equal(activeNodeOperatorsCountAfter.toNumber(), activeNodeOperatorsCountBefore.toNumber() - 1)
    })

    it('resets depositable when depositable was greater thatn zero', async () => {
      const activeNodeOperatorId = await nodeOperators.findNodeOperatorId(app, (operator) => operator.active)
      assert.notEqual(activeNodeOperatorId, -1, `Invariant: active node operator not found`)

      const [nodeOperator, operatorReportBefore, allValidatorsReportBefore] = await Promise.all([
        app.getNodeOperator(activeNodeOperatorId, false),
        app.getNodeOperatorSummary(activeNodeOperatorId),
        app.getStakingModuleSummary()
      ])

      assert.isTrue(
        +operatorReportBefore.depositableValidatorsCount > 0,
        'invariant failed: readyToDepositValidatorsKeysCountBefore <= depositedSigningKeysCount'
      )
      assert.isTrue(nodeOperator.active, 'Invariant Failed: not active')
      assert.isTrue(+operatorReportBefore.totalDepositedValidators > 0, 'Invariant Failed: vettedSigningKeysCount === 0')
      await app.deactivateNodeOperator(activeNodeOperatorId, { from: voting })

      const [operatorReportAfter, allValidatorsReportAfter] = await Promise.all([
        app.getNodeOperatorSummary(activeNodeOperatorId),
        app.getStakingModuleSummary()
      ])

      assert.equals(+operatorReportAfter.depositableValidatorsCount, 0)

      // check that total and node operator's data were changed on same value
      assert.equals(
        +allValidatorsReportBefore.depositableValidatorsCount - +allValidatorsReportAfter.depositableValidatorsCount,
        +operatorReportBefore.depositableValidatorsCount
      )
    })

    it('emits VettedSigningKeysCountChanged event when vettedSigningKeysCount > depositedSigningKeysCount', async () => {
      const activeNodeOperatorId = await nodeOperators.findNodeOperatorId(app, (operator) => operator.active)
      assert.notEqual(activeNodeOperatorId, -1, `Invariant: active node operator not found`)

      const { usedSigningKeys, stakingLimit } = await app.getNodeOperator(activeNodeOperatorId, false)

      assert.isTrue(
        stakingLimit.toNumber() > usedSigningKeys.toString(),
        'invariant failed: readyToDepositValidatorsKeysCountBefore <= depositedSigningKeysCount'
      )

      const receipt = await app.deactivateNodeOperator(activeNodeOperatorId, { from: voting })
      assert.emits(receipt, 'VettedSigningKeysCountChanged', {
        nodeOperatorId: activeNodeOperatorId,
        approvedValidatorsCount: usedSigningKeys
      })
    })

    it("doesn't modify deposited keys count", async () => {
      const activeNodeOperatorId = await nodeOperators.findNodeOperatorId(app, (operator) => operator.active)
      assert.notEqual(activeNodeOperatorId, -1, `Invariant: active node operator not found`)

      const [nodeOperator, operatorReportBefore, allValidatorsReportBefore] = await Promise.all([
        app.getNodeOperator(activeNodeOperatorId, false),
        app.getNodeOperatorSummary(activeNodeOperatorId),
        app.getStakingModuleSummary()
      ])

      assert.isTrue(nodeOperator.active, 'Invariant Failed: not active')
      await app.deactivateNodeOperator(activeNodeOperatorId, { from: voting })

      const [operatorReportAfter, allValidatorsReportAfter] = await Promise.all([
        app.getNodeOperatorSummary(activeNodeOperatorId),
        app.getStakingModuleSummary()
      ])

      assert.equals(operatorReportBefore.totalDepositedValidators, operatorReportAfter.totalDepositedValidators)
      assert.equals(allValidatorsReportBefore.totalDepositedValidators, allValidatorsReportAfter.totalDepositedValidators)
    })

    it('emits NodeOperatorActiveSet(deactivate) event with correct params', async () => {
      const activeNodeOperatorId = await nodeOperators.findNodeOperatorId(app, (operator) => operator.active)
      assert.notEqual(activeNodeOperatorId, -1, `Invariant: active node operator not found`)

      const receipt = await app.deactivateNodeOperator(activeNodeOperatorId, { from: voting })

      assert.emits(receipt, 'NodeOperatorActiveSet', { nodeOperatorId: activeNodeOperatorId, active: false })
    })

    it('increases keysOpIndex & changes nonce', async () => {
      const activeNodeOperatorId = await nodeOperators.findNodeOperatorId(app, (operator) => operator.active)
      assert.notEqual(activeNodeOperatorId, -1, `Invariant: active node operator not found`)
      const [keysOpIndexBefore, nonceBefore] = await Promise.all([app.getKeysOpIndex(), app.getNonce()])
      await app.deactivateNodeOperator(activeNodeOperatorId, { from: voting })
      const [keysOpIndexAfter, nonceAfter] = await Promise.all([app.getKeysOpIndex(), app.getNonce()])
      assert.equals(keysOpIndexAfter, keysOpIndexBefore.toNumber() + 1)
      assert.notEquals(nonceAfter, nonceBefore)
    })

    it('emits KeysOpIndexSet & NonceChanged', async () => {
      const activeNodeOperatorId = await nodeOperators.findNodeOperatorId(app, (operator) => operator.active)
      assert.notEqual(activeNodeOperatorId, -1, `Invariant: active node operator not found`)
      const keysOpIndexBefore = await app.getKeysOpIndex()
      const receipt = await app.deactivateNodeOperator(activeNodeOperatorId, { from: voting })
      const nonceAfter = await app.getNonce()
      assert.emits(receipt, 'KeysOpIndexSet', { keysOpIndex: keysOpIndexBefore.toNumber() + 1 })
      assert.emits(receipt, 'NonceChanged', { nonce: nonceAfter })
    })
  })

  describe('setNodeOperatorName()', async () => {
    beforeEach(async () => {
      await nodeOperators.addNodeOperator(app, NODE_OPERATORS[0], { from: voting })
      await nodeOperators.addNodeOperator(app, NODE_OPERATORS[2], { from: voting })
    })

    it('reverts with "OUT_OF_RANGE" error when called on non existent node operator', async () => {
      const notExitedNodeOperatorId = await app.getNodeOperatorsCount()
      await assert.reverts(
        app.setNodeOperatorName(notExitedNodeOperatorId, 'new name', { from: voting }),
        'OUT_OF_RANGE'
      )
    })

    it('reverts with "WRONG_NAME_LENGTH" error when called with empty name', async () => {
      const nodeOperatorId = 0
      await assert.reverts(app.setNodeOperatorName(nodeOperatorId, '', { from: voting }), 'WRONG_NAME_LENGTH')
    })

    it('reverts with "WRONG_NAME_LENGTH" error when name exceeds MAX_NODE_OPERATOR_NAME_LENGTH', async () => {
      const nodeOperatorId = 0
      const maxNameLength = await app.MAX_NODE_OPERATOR_NAME_LENGTH()
      const tooLongName = '#'.repeat(maxNameLength.toNumber() + 1)
      assert(tooLongName.length > maxNameLength.toNumber())
      await assert.reverts(app.setNodeOperatorName(nodeOperatorId, tooLongName, { from: voting }), 'WRONG_NAME_LENGTH')
    })

    it('reverts with "APP_AUTH_FAILED" error when called by address without MANAGE_NODE_OPERATOR_ROLE', async () => {
      const hasPermission = await dao.hasPermission(nobody, app, 'MANAGE_NODE_OPERATOR_ROLE')
      assert.isFalse(hasPermission)
      await assert.reverts(app.setNodeOperatorName(0, 'new name', { from: nobody }), 'APP_AUTH_FAILED')
    })

    it('reverts with "VALUE_IS_THE_SAME" error when called with the same name', async () => {
      const nodeOperatorId = 0
      const { name: currentName } = await app.getNodeOperator(nodeOperatorId, true)
      await assert.reverts(app.setNodeOperatorName(nodeOperatorId, currentName, { from: voting }), 'VALUE_IS_THE_SAME')
    })

    it('updates the node operator name', async () => {
      const nodeOperatorId = 0
      const newName = 'new name'
      await app.setNodeOperatorName(nodeOperatorId, newName, { from: voting })
      const { name: nameAfter } = await app.getNodeOperator(nodeOperatorId, true)
      assert(nameAfter === newName)
    })

    it('emits NodeOperatorNameSet event with correct params', async () => {
      const nodeOperatorId = 0
      const newName = 'new name'
      const receipt = await app.setNodeOperatorName(nodeOperatorId, newName, { from: voting })
      assert.emits(
        receipt,
        'NodeOperatorNameSet',
        { nodeOperatorId, name: newName },
        { abi: NodeOperatorsRegistry._json.abi }
      )
    })
    it("doesn't affect the names of other node operators", async () => {
      const nodeOperatorId = 0
      const anotherNodeOperatorId = 1
      const newName = 'new name'
      const { name: anotherNodeOperatorNameBefore } = await app.getNodeOperator(anotherNodeOperatorId, true)
      await app.setNodeOperatorName(nodeOperatorId, newName, { from: voting })
      const { name: anotherNodeOperatorNameAfter } = await app.getNodeOperator(anotherNodeOperatorId, true)
      assert.equal(anotherNodeOperatorNameBefore, anotherNodeOperatorNameAfter)
    })
  })

  describe('setNodeOperatorRewardAddress()', async () => {
    const firstNodeOperatorId = 0
    const secondNodeOperatorId = 1
    const notExistedNodeOperatorId = 2

    beforeEach(async () => {
      await nodeOperators.addNodeOperator(app, NODE_OPERATORS[0], { from: voting })
      await nodeOperators.addNodeOperator(app, NODE_OPERATORS[1], { from: voting })
    })

    it('reverts with "OUT_OF_RANGE" error when called on non existent node operator', async () => {
      await assert.reverts(
        app.setNodeOperatorRewardAddress(notExistedNodeOperatorId, ADDRESS_4, { from: voting }),
        'OUT_OF_RANGE'
      )
    })

    it('reverts with "ZERO_ADDRESS" error when new address is zero', async () => {
      await assert.reverts(
        app.setNodeOperatorRewardAddress(firstNodeOperatorId, ZERO_ADDRESS, { from: voting }),
        'ZERO_ADDRESS'
      )
    })

    it(`reverts with "APP_AUTH_FAILED" error when caller doesn't have MANAGE_NODE_OPERATOR_ROLE`, async () => {
      const hasPermission = await dao.hasPermission(nobody, app, 'MANAGE_NODE_OPERATOR_ROLE')
      assert.isFalse(hasPermission)
      await assert.reverts(
        app.setNodeOperatorRewardAddress(firstNodeOperatorId, ADDRESS_4, { from: nobody }),
        'APP_AUTH_FAILED'
      )
    })

    it(`reverts with "VALUE_IS_THE_SAME" error when new reward address is the same`, async () => {
      const nodeOperator = await app.getNodeOperator(firstNodeOperatorId, false)
      await assert.reverts(
        app.setNodeOperatorRewardAddress(firstNodeOperatorId, nodeOperator.rewardAddress, { from: voting }),
        'VALUE_IS_THE_SAME'
      )
    })

    it('updates the reward address of the node operator', async () => {
      const { rewardAddress: rewardAddressBefore } = await app.getNodeOperator(firstNodeOperatorId, false)
      assert.notEqual(rewardAddressBefore, ADDRESS_4)
      await app.setNodeOperatorRewardAddress(firstNodeOperatorId, ADDRESS_4, { from: voting })
      const { rewardAddress: rewardAddressAfter } = await app.getNodeOperator(firstNodeOperatorId, false)
      assert.equal(rewardAddressAfter, ADDRESS_4)
    })

    it('emits "NodeOperatorRewardAddressSet" event with correct params', async () => {
      const receipt = await app.setNodeOperatorRewardAddress(firstNodeOperatorId, ADDRESS_4, { from: voting })
      assert.emits(receipt, 'NodeOperatorRewardAddressSet', {
        nodeOperatorId: firstNodeOperatorId,
        rewardAddress: ADDRESS_4
      })
    })

    it("doesn't affect other node operators reward addresses", async () => {
      const { rewardAddress: secondNodeOperatorRewardAddressBefore } = await app.getNodeOperator(
        secondNodeOperatorId,
        true
      )
      await app.setNodeOperatorRewardAddress(firstNodeOperatorId, ADDRESS_4, { from: voting })
      const { rewardAddress: secondNodeOperatorRewardAddressAfter } = await app.getNodeOperator(
        secondNodeOperatorId,
        true
      )
      assert.equal(secondNodeOperatorRewardAddressAfter, secondNodeOperatorRewardAddressBefore)
    })
  })

  describe('setNodeOperatorStakingLimit()', async () => {
    const firstNodeOperatorId = 0
    const secondNodeOperatorId = 1
    const notExistedNodeOperatorId = 3

    beforeEach(async () => {
      await nodeOperators.addNodeOperator(
        app,
        { ...NODE_OPERATORS[0], totalSigningKeysCount: 100, vettedSigningKeysCount: 50, depositedSigningKeysCount: 20 },
        { from: voting }
      )
      await nodeOperators.addNodeOperator(
        app,
        { ...NODE_OPERATORS[1], totalSigningKeysCount: 50, vettedSigningKeysCount: 45, depositedSigningKeysCount: 30 },
        { from: voting }
      )
    })

    it('reverts with "APP_AUTH_FAILED" error when called by sender without SET_NODE_OPERATOR_LIMIT_ROLE', async () => {
      const hasPermission = await dao.hasPermission(nobody, app, 'SET_NODE_OPERATOR_LIMIT_ROLE')
      assert.isFalse(hasPermission)
      await assert.reverts(
        app.setNodeOperatorStakingLimit(firstNodeOperatorId, 40, { from: nobody }),
        'APP_AUTH_FAILED'
      )
    })

    it('reverts with "OUT_OF_RANGE" error when called on non existent validator', async () => {
      const hasPermission = await dao.hasPermission(voting, app, 'SET_NODE_OPERATOR_LIMIT_ROLE')
      assert.isTrue(hasPermission)
      await assert.reverts(
        app.setNodeOperatorStakingLimit(notExistedNodeOperatorId, 40, { from: voting }),
        'OUT_OF_RANGE'
      )
    })

    it('reverts with "WRONG_OPERATOR_ACTIVE_STATE" error when node operator deactivated', async () => {
      const hasPermission = await dao.hasPermission(voting, app, 'SET_NODE_OPERATOR_LIMIT_ROLE')
      assert.isTrue(hasPermission)
      await app.deactivateNodeOperator(secondNodeOperatorId, { from: voting })
      assert.isFalse(await app.getNodeOperatorIsActive(secondNodeOperatorId))
      await assert.reverts(
        app.setNodeOperatorStakingLimit(secondNodeOperatorId, 40, { from: voting }),
        'WRONG_OPERATOR_ACTIVE_STATE'
      )
    })

    it('newStakingLimit < depositedSigningKeys :: sets staking limit to deposited signing keys count', async () => {
      await app.setNodeOperatorStakingLimit(firstNodeOperatorId, 10, { from: voting })
      const nodeOperator = await app.getNodeOperator(firstNodeOperatorId, false)
      assert.equals(nodeOperator.stakingLimit, 20)
    })

    it('newStakingLimit > totalSigningKeysCount :: sets staking limit to total signing keys count', async () => {
      await app.setNodeOperatorStakingLimit(secondNodeOperatorId, 1000, { from: voting })
      const nodeOperator = await app.getNodeOperator(secondNodeOperatorId, false)
      assert.equals(nodeOperator.stakingLimit, 50)
    })

    it('depositedSigningKeys <= newStakingLimit <= totalSigningKeysCount :: sets staking limit to passed value', async () => {
      await app.setNodeOperatorStakingLimit(firstNodeOperatorId, 75, { from: voting })
      const nodeOperator = await app.getNodeOperator(firstNodeOperatorId, false)
      assert.equals(nodeOperator.stakingLimit, 75)
    })

    it("doesn't change state & doesn't emit events when new staking limit is the same", async () => {
      const [{ stakingLimit: stakingLimitBefore }, nonceBefore, keysOpIndexBefore] = await Promise.all([
        app.getNodeOperator(firstNodeOperatorId, false),
        app.getNonce(),
        app.getKeysOpIndex()
      ])
      const receipt = await app.setNodeOperatorStakingLimit(firstNodeOperatorId, stakingLimitBefore, { from: voting })
      assert.notEmits(receipt, 'VettedSigningKeysCountChanged')
      const [{ stakingLimit: stakingLimitAfter }, nonceAfter, keysOpIndexAfter] = await Promise.all([
        app.getNodeOperator(firstNodeOperatorId, false),
        app.getNonce(),
        app.getKeysOpIndex()
      ])
      assert.equals(stakingLimitBefore, stakingLimitAfter)
      assert.equals(keysOpIndexBefore, keysOpIndexAfter)
      assert.equals(nonceBefore, nonceAfter)
    })

    it('reduces total vetted validator keys count correctly if new value less than previous', async () => {
      const { vettedSigningKeysCount: vettedSigningKeysCountBefore } = await app.testing_getTotalSigningKeysStats()
      await app.setNodeOperatorStakingLimit(firstNodeOperatorId, 30, { from: voting })
      const { vettedSigningKeysCount: vettedSigningKeysCountAfter } = await app.testing_getTotalSigningKeysStats()
      assert.equal(vettedSigningKeysCountBefore.toNumber() - vettedSigningKeysCountAfter.toNumber(), 20)
    })

    it('increases total vetted validator keys count correctly if new value greater than previous', async () => {
      const { vettedSigningKeysCount: vettedSigningKeysCountBefore } = await app.testing_getTotalSigningKeysStats()
      await app.setNodeOperatorStakingLimit(firstNodeOperatorId, 100, { from: voting })
      const { vettedSigningKeysCount: vettedSigningKeysCountAfter } = await app.testing_getTotalSigningKeysStats()
      assert.equal(vettedSigningKeysCountAfter.toNumber() - vettedSigningKeysCountBefore.toNumber(), 50)
    })

    it('emits VettedSigningKeysCountChanged event with correct params', async () => {
      const newStakingLimit = 75
      const receipt = await app.setNodeOperatorStakingLimit(firstNodeOperatorId, newStakingLimit, { from: voting })
      assert.emits(receipt, 'VettedSigningKeysCountChanged', {
        nodeOperatorId: firstNodeOperatorId,
        approvedValidatorsCount: newStakingLimit
      })
    })

    it('increases keysOpIndex & changes nonce on vettedSigningKeysCount change', async () => {
      const [keysOpIndexBefore, nonceBefore] = await Promise.all([app.getKeysOpIndex(), app.getNonce()])
      await app.setNodeOperatorStakingLimit(0, 40, { from: voting })
      const [keysOpIndexAfter, nonceAfter] = await Promise.all([app.getKeysOpIndex(), app.getNonce()])
      assert.equals(keysOpIndexAfter, keysOpIndexBefore.toNumber() + 1)
      assert.equals(nonceAfter, nonceBefore.toNumber() + 1)
    })

    it('emits KeysOpIndexSet & NonceChanged on vettedSigningKeysCount change', async () => {
      const keysOpIndexBefore = await app.getKeysOpIndex()
      const receipt = await app.setNodeOperatorStakingLimit(0, 40, { from: voting })
      const nonceAfter = await app.getNonce()
      assert.emits(receipt, 'KeysOpIndexSet', { keysOpIndex: keysOpIndexBefore.toNumber() + 1 })
      assert.emits(receipt, 'NonceChanged', { nonce: nonceAfter })
    })

    it("doesn't affect other node operators staking limits", async () => {
      const { stakingLimit: secondNodeOperatorStakingLimitBefore } = await app.getNodeOperator(
        secondNodeOperatorId,
        true
      )
      await app.setNodeOperatorRewardAddress(firstNodeOperatorId, ADDRESS_4, { from: voting })
      const { stakingLimit: secondNodeOperatorStakingLimitAfter } = await app.getNodeOperator(
        secondNodeOperatorId,
        true
      )
      assert.equals(secondNodeOperatorStakingLimitAfter, secondNodeOperatorStakingLimitBefore)
    })
  })

  describe('updateExitedValidatorsCount()', () => {
    const firstNodeOperatorId = 0
    const secondNodeOperatorId = 1
    const notExistedNodeOperatorId = 2

    beforeEach(async () => {
      await nodeOperators.addNodeOperator(app, { ...NODE_OPERATORS[0], exitedSigningKeysCount: 3 }, { from: voting })
      await nodeOperators.addNodeOperator(app, NODE_OPERATORS[1], { from: voting })
    })

    it('reverts with "OUT_OF_RANGE" error when called on non existent validator', async () => {
      const hasPermission = await dao.hasPermission(voting, app, 'STAKING_ROUTER_ROLE')
      assert.isTrue(hasPermission)
      await assert.reverts(app.updateExitedValidatorsCount(notExistedNodeOperatorId, 40, { from: voting }), 'OUT_OF_RANGE')
    })

    it('reverts with "APP_AUTH_FAILED" error when called by sender without STAKING_ROUTER_ROLE', async () => {
      const hasPermission = await dao.hasPermission(nobody, app, 'STAKING_ROUTER_ROLE')
      assert.isFalse(hasPermission)
      await assert.reverts(app.updateExitedValidatorsCount(firstNodeOperatorId, 40, { from: nobody }), 'APP_AUTH_FAILED')
    })

    it("doesn't change the state when new value is equal to the previous one", async () => {
      const { stoppedValidators: exitedValidatorsKeysCountBefore } = await app.getNodeOperator(firstNodeOperatorId, false)
      await app.updateExitedValidatorsCount(firstNodeOperatorId, exitedValidatorsKeysCountBefore, { from: voting })
      const { stoppedValidators: exitedValidatorsKeysCountAfter } = await app.getNodeOperator(firstNodeOperatorId, false)
      assert.equals(exitedValidatorsKeysCountBefore, exitedValidatorsKeysCountAfter)
    })

    it("doesn't emit ExitedSigningKeysCountChanged event when new value is equal to the previous one", async () => {
      const { stoppedValidators: exitedValidatorsKeysCountBefore } = await app.getNodeOperator(firstNodeOperatorId, false)
      const receipt = await app.updateExitedValidatorsCount(firstNodeOperatorId, exitedValidatorsKeysCountBefore, { from: voting })
      assert.notEmits(receipt, 'ExitedSigningKeysCountChanged')
    })

    it('reverts with "OUT_OF_RANGE" error when new exitedValidatorsKeysCount > depositedSigningKeysCount', async () => {
      const newExitedValidatorsCount = 1000
      const nodeOperator = await app.getNodeOperator(firstNodeOperatorId, false)
      assert(newExitedValidatorsCount > nodeOperator.usedSigningKeys.toNumber())
      await assert.reverts(
        app.updateExitedValidatorsCount(firstNodeOperatorId, newExitedValidatorsCount, { from: voting }),
        'OUT_OF_RANGE'
      )
    })

    it('reverts with "EXITED_VALIDATORS_COUNT_DECREASED" error when new exitedValidatorsKeysCount less then current one', async () => {
      const nodeOperator = await app.getNodeOperator(firstNodeOperatorId, false)
      assert(nodeOperator.stoppedValidators.toNumber() > 0, 'invariant failed: no exited validators')
      const newExitedValidatorsKeysCount = nodeOperator.stoppedValidators.toNumber() - 1
      await assert.reverts(
        app.updateExitedValidatorsCount(firstNodeOperatorId, newExitedValidatorsKeysCount, { from: voting }),
        'EXITED_VALIDATORS_COUNT_DECREASED'
      )
    })

    it('increases exited signing keys count of node operator', async () => {
      const newExitedValidatorsCount = 5
      const { stoppedValidators: exitedValidatorsKeysCountBefore } = await app.getNodeOperator(
        secondNodeOperatorId,
        false
      )
      assert.notEquals(exitedValidatorsKeysCountBefore, newExitedValidatorsCount)
      await app.updateExitedValidatorsCount(secondNodeOperatorId, newExitedValidatorsCount, { from: voting })
      const { stoppedValidators: exitedValidatorsKeysCountAfter } = await app.getNodeOperator(secondNodeOperatorId, false)
      assert.equals(exitedValidatorsKeysCountAfter, newExitedValidatorsCount)
    })

    it('increases the total exited signing keys count', async () => {
      const newExitedValidatorsCount = 4
      const [{ stoppedValidators: exitedValidatorsKeysCountBefore }, { exitedSigningKeysCount: exitedSigningKeysCountBefore }] =
        await Promise.all([await app.getNodeOperator(firstNodeOperatorId, false), app.testing_getTotalSigningKeysStats()])
      await app.updateExitedValidatorsCount(firstNodeOperatorId, newExitedValidatorsCount, { from: voting })
      const exitedSigningKeysCountIncrement = newExitedValidatorsCount - exitedValidatorsKeysCountBefore.toNumber()
      const { exitedSigningKeysCount: exitedSigningKeysCountAfter } = await app.testing_getTotalSigningKeysStats()
      assert.equals(
        exitedSigningKeysCountBefore.toNumber() + exitedSigningKeysCountIncrement,
        exitedSigningKeysCountAfter
      )
    })

    it('emits ExitedSigningKeysCountChanged event with correct params', async () => {
      const newExitedValidatorsCount = 4
      const receipt = await app.updateExitedValidatorsCount(firstNodeOperatorId, newExitedValidatorsCount, { from: voting })
      assert.emits(receipt, 'ExitedSigningKeysCountChanged', {
        nodeOperatorId: firstNodeOperatorId,
        exitedValidatorsCount: newExitedValidatorsCount
      })
    })

    it("doesn't change the exited signing keys count of other node operators", async () => {
      const newExitedValidatorsCount = 4
      const { stakingLimit: secondNodeOperatorStakingLimitBefore } = await app.getNodeOperator(firstNodeOperatorId, true)
      await app.updateExitedValidatorsCount(secondNodeOperatorId, newExitedValidatorsCount, { from: voting })
      const { stakingLimit: secondNodeOperatorStakingLimitAfter } = await app.getNodeOperator(firstNodeOperatorId, true)
      assert.equals(secondNodeOperatorStakingLimitAfter, secondNodeOperatorStakingLimitBefore)
    })
  })

  describe('unsafeUpdateValidatorsCount(): exited validators update', () => {
    const firstNodeOperatorId = 0
    const secondNodeOperatorId = 1
    const notExistedNodeOperatorId = 2
    const exitedValidatorsCount = 4
    const stuckValidatorsCount = 2

    beforeEach(async () => {
      await nodeOperators.addNodeOperator(app, { ...NODE_OPERATORS[0], exitedSigningKeysCount: 4 }, { from: voting })
      await nodeOperators.addNodeOperator(app, NODE_OPERATORS[1], { from: voting })
    })

    it('decreases the stuck validators count when new value is less then previous one', async () => {
      const newStuckValidatorsCount = 1
      await app.unsafeUpdateValidatorsCount(firstNodeOperatorId, exitedValidatorsCount, stuckValidatorsCount, {
        from: voting
      })

      const { stuckValidatorsCount: stuckValidatorsCountBefore } = await app.getNodeOperatorSummary(firstNodeOperatorId)
      assert(newStuckValidatorsCount < stuckValidatorsCountBefore)
      await app.unsafeUpdateValidatorsCount(firstNodeOperatorId, exitedValidatorsCount, newStuckValidatorsCount, {
        from: voting
      })
      const { stuckValidatorsCount: stuckValidatorsCountAfter } = await app.getNodeOperatorSummary(firstNodeOperatorId)
      assert.equals(stuckValidatorsCountAfter, newStuckValidatorsCount)
    })

    it('increases the stuck validators count when new value is greater then previous one', async () => {
      const newStuckValidatorsCount = 3
      const { stuckValidatorsCount: stuckValidatorsCountBefore } = await app.getNodeOperatorSummary(secondNodeOperatorId)
      assert(newStuckValidatorsCount > stuckValidatorsCountBefore)
      await app.unsafeUpdateValidatorsCount(secondNodeOperatorId, exitedValidatorsCount, newStuckValidatorsCount, {
        from: voting
      })
      const { stuckValidatorsCount: stuckValidatorsCountAfter } = await app.getNodeOperatorSummary(secondNodeOperatorId)
      assert.equals(stuckValidatorsCountAfter, newStuckValidatorsCount)
    })

    it('emits StuckValidatorsCountChanged event with correct params', async () => {
      const newStuckValidatorsCount = 3
      const receipt = await app.unsafeUpdateValidatorsCount(
        firstNodeOperatorId,
        exitedValidatorsCount,
        newStuckValidatorsCount,
        { from: voting }
      )
      assert.emits(receipt, 'StuckValidatorsCountChanged', {
        nodeOperatorId: firstNodeOperatorId,
        stuckValidatorsCount: newStuckValidatorsCount
      })
    })

    it("doesn't change the state when new stuck validators value is equal to the previous one", async () => {
      const { stuckValidatorsCount: stuckValidatorsCountBefore } = await app.getNodeOperatorSummary(firstNodeOperatorId)
      await app.unsafeUpdateValidatorsCount(
        firstNodeOperatorId,
        exitedValidatorsCount,
        stuckValidatorsCountBefore,
        {
          from: voting
        }
      )

      const { stuckValidatorsCount: stuckValidatorsCountAfter } = await app.getNodeOperatorSummary(firstNodeOperatorId)
      assert.equals(stuckValidatorsCountBefore, stuckValidatorsCountAfter)
    })

    it("doesn't emit StuckValidatorsCountChanged event when new value is equal to the previous one", async () => {
      const { stuckValidatorsCount: stuckValidatorsCountBefore } = await app.getNodeOperatorSummary(firstNodeOperatorId)
      const receipt = await app.unsafeUpdateValidatorsCount(
        firstNodeOperatorId,
        exitedValidatorsCount,
        stuckValidatorsCountBefore,
        {
          from: voting
        }
      )
      assert.notEmits(receipt, 'StuckValidatorsCountChanged')
    })

    it("doesn't change the stuck validators count of other node operators", async () => {
      const newStuckValidatorsCount = 3
      const { stuckValidatorsCount: secondNodeOperatorStuckValidatorsCountBefore } = await app.getNodeOperatorSummary(
        firstNodeOperatorId
      )
      await app.unsafeUpdateValidatorsCount(secondNodeOperatorId, exitedValidatorsCount, newStuckValidatorsCount, {
        from: voting
      })
      const { stuckValidatorsCount: secondNodeOperatorStuckValidatorsCountAfter } = await app.getNodeOperatorSummary(
        firstNodeOperatorId
      )
      assert.equals(secondNodeOperatorStuckValidatorsCountAfter, secondNodeOperatorStuckValidatorsCountBefore)
    })

    it('reverts with "OUT_OF_RANGE" error when new exitedValidatorsKeysCount < stuckValidatorsCount', async () => {
      const newStuckValidatorsCount = 1000
      const { stuckValidatorsCount } = await app.getNodeOperatorSummary(firstNodeOperatorId)
      assert(newStuckValidatorsCount > stuckValidatorsCount)
      await assert.reverts(
        app.unsafeUpdateValidatorsCount(firstNodeOperatorId, exitedValidatorsCount, newStuckValidatorsCount, {
          from: voting
        }),
        'OUT_OF_RANGE'
      )
    })

    it('reverts with "OUT_OF_RANGE" error when called on non existent validator', async () => {
      const hasPermission = await dao.hasPermission(voting, app, 'STAKING_ROUTER_ROLE')
      assert.isTrue(hasPermission)
      await assert.reverts(
        app.unsafeUpdateValidatorsCount(notExistedNodeOperatorId, 40, stuckValidatorsCount, { from: voting }),
        'OUT_OF_RANGE'
      )
    })

    it('reverts with "APP_AUTH_FAILED" error when called by sender without STAKING_ROUTER_ROLE', async () => {
      const hasPermission = await dao.hasPermission(nobody, app, 'STAKING_ROUTER_ROLE')
      assert.isFalse(hasPermission)
      await assert.reverts(app.unsafeUpdateValidatorsCount(firstNodeOperatorId, 40, stuckValidatorsCount, { from: nobody }), 'APP_AUTH_FAILED')
    })

    it("doesn't change the state when new value is equal to the previous one", async () => {
      const { stoppedValidators: exitedValidatorsKeysCountBefore } = await app.getNodeOperator(firstNodeOperatorId, false)
      await app.unsafeUpdateValidatorsCount(firstNodeOperatorId, exitedValidatorsKeysCountBefore, stuckValidatorsCount, { from: voting })
      const { stoppedValidators: exitedValidatorsKeysCountAfter } = await app.getNodeOperator(firstNodeOperatorId, false)
      assert.equals(exitedValidatorsKeysCountBefore, exitedValidatorsKeysCountAfter)
    })

    it("doesn't emit ExitedSigningKeysCountChanged event when new value is equal to the previous one", async () => {
      const { stoppedValidators: exitedValidatorsKeysCountBefore } = await app.getNodeOperator(firstNodeOperatorId, false)
      const receipt = await app.unsafeUpdateValidatorsCount(firstNodeOperatorId, exitedValidatorsKeysCountBefore, stuckValidatorsCount, {
        from: voting
      })
      assert.notEmits(receipt, 'ExitedSigningKeysCountChanged')
    })

    it('reverts with "OUT_OF_RANGE" error when new exitedValidatorsKeysCount > depositedSigningKeysCount', async () => {
      const newExitedValidatorsCount = 1000
      const nodeOperator = await app.getNodeOperator(firstNodeOperatorId, false)
      assert(newExitedValidatorsCount > nodeOperator.usedSigningKeys.toNumber())
      await assert.reverts(
        app.unsafeUpdateValidatorsCount(firstNodeOperatorId, newExitedValidatorsCount, stuckValidatorsCount, { from: voting }),
        'OUT_OF_RANGE'
      )
    })

    it('decreases the exited validators count when new value is less then previous one', async () => {
      const newExitedValidatorsCount = 2
      const { stoppedValidators: exitedValidatorsKeysCountBefore } = await app.getNodeOperator(
        firstNodeOperatorId,
        false
      )
      assert(newExitedValidatorsCount < exitedValidatorsKeysCountBefore.toNumber())
      await app.unsafeUpdateValidatorsCount(firstNodeOperatorId, newExitedValidatorsCount, stuckValidatorsCount, { from: voting })
      const { stoppedValidators: exitedValidatorsKeysCountAfter } = await app.getNodeOperator(firstNodeOperatorId, false)
      assert.equals(exitedValidatorsKeysCountAfter, newExitedValidatorsCount)
    })

    it('increases the exited validators count when new value is greater then previous one', async () => {
      const newExitedValidatorsCount = 3
      const { stoppedValidators: exitedValidatorsKeysCountBefore } = await app.getNodeOperator(
        secondNodeOperatorId,
        false
      )
      assert(newExitedValidatorsCount > exitedValidatorsKeysCountBefore.toNumber())
      await app.unsafeUpdateValidatorsCount(secondNodeOperatorId, newExitedValidatorsCount, stuckValidatorsCount, { from: voting })
      const { stoppedValidators: exitedValidatorsKeysCountAfter } = await app.getNodeOperator(secondNodeOperatorId, false)
      assert.equals(exitedValidatorsKeysCountAfter, newExitedValidatorsCount)
    })

    it('decreases the total exited signing keys count when new value is less then previous one', async () => {
      const newExitedValidatorsCount = 3
      const [
        { stoppedValidators: exitedValidatorsKeysCountBefore },
        { exitedSigningKeysCount: exitedSigningKeysCountBefore }
      ] = await Promise.all([
        await app.getNodeOperator(firstNodeOperatorId, false),
        app.testing_getTotalSigningKeysStats()
      ])
      assert(newExitedValidatorsCount < exitedValidatorsKeysCountBefore.toNumber())
      await app.unsafeUpdateValidatorsCount(firstNodeOperatorId, newExitedValidatorsCount, stuckValidatorsCount, { from: voting })
      const exitedSigningKeysCountIncrement = exitedValidatorsKeysCountBefore.toNumber() - newExitedValidatorsCount
      const { exitedSigningKeysCount: exitedSigningKeysCountAfter } = await app.testing_getTotalSigningKeysStats()
      assert.equals(
        exitedSigningKeysCountBefore.toNumber() - exitedSigningKeysCountIncrement,
        exitedSigningKeysCountAfter
      )
    })

    it('increases the total exited signing keys count when new value is greater then previous one', async () => {
      const newExitedValidatorsCount = 5
      const [
        { stoppedValidators: exitedValidatorsKeysCountBefore },
        { exitedSigningKeysCount: exitedSigningKeysCountBefore }
      ] = await Promise.all([
        await app.getNodeOperator(firstNodeOperatorId, false),
        app.testing_getTotalSigningKeysStats()
      ])
      assert(newExitedValidatorsCount > exitedValidatorsKeysCountBefore.toNumber())
      await app.unsafeUpdateValidatorsCount(firstNodeOperatorId, newExitedValidatorsCount, stuckValidatorsCount, { from: voting })
      const exitedSigningKeysCountIncrement = newExitedValidatorsCount - exitedValidatorsKeysCountBefore.toNumber()
      const { exitedSigningKeysCount: exitedSigningKeysCountAfter } = await app.testing_getTotalSigningKeysStats()
      assert.equals(
        exitedSigningKeysCountBefore.toNumber() + exitedSigningKeysCountIncrement,
        exitedSigningKeysCountAfter
      )
    })

    it('emits ExitedSigningKeysCountChanged event with correct params', async () => {
      const newExitedValidatorsCount = 2
      const receipt = await app.unsafeUpdateValidatorsCount(
        firstNodeOperatorId, newExitedValidatorsCount, stuckValidatorsCount, { from: voting }
      )
      assert.emits(receipt, 'ExitedSigningKeysCountChanged', {
        nodeOperatorId: firstNodeOperatorId,
        exitedValidatorsCount: newExitedValidatorsCount
      })
    })

    it("doesn't change the exited signing keys count of other node operators", async () => {
      const newExitedValidatorsCount = 4
      const { stakingLimit: secondNodeOperatorStakingLimitBefore } = await app.getNodeOperator(firstNodeOperatorId, true)
      await app.unsafeUpdateValidatorsCount(
        secondNodeOperatorId, newExitedValidatorsCount, stuckValidatorsCount, { from: voting }
      )
      await app.unsafeUpdateValidatorsCount(secondNodeOperatorId, newExitedValidatorsCount, stuckValidatorsCount, {
        from: voting
      })
      const { stakingLimit: secondNodeOperatorStakingLimitAfter } = await app.getNodeOperator(firstNodeOperatorId, true)
      assert.equals(secondNodeOperatorStakingLimitAfter, secondNodeOperatorStakingLimitBefore)
    })
  })

  describe('onWithdrawalCredentialsChanged()', () => {
    beforeEach(async () => {
      await nodeOperators.addNodeOperator(app, NODE_OPERATORS[0], { from: voting })
      await nodeOperators.addNodeOperator(app, NODE_OPERATORS[1], { from: voting })
      // node operator without unused keys
      await nodeOperators.addNodeOperator(
        app,
        {
          ...NODE_OPERATORS[2],
          vettedSigningKeysCount: NODE_OPERATORS[2].totalSigningKeysCount,
          depositedSigningKeysCount: NODE_OPERATORS[2].totalSigningKeysCount
        },
        { from: voting }
      )
    })

    it('reverts with "APP_AUTH_FAILED" error when called by sender without MANAGE_NODE_OPERATOR_ROLE role', async () => {
      const hasPermission = await dao.hasPermission(nobody, app, 'MANAGE_NODE_OPERATOR_ROLE')
      assert.isFalse(hasPermission)
      await assert.reverts(app.onWithdrawalCredentialsChanged(), 'APP_AUTH_FAILED')
    })

    it('sets totalSigningKeysCount and vettedSigningKeysCount equal to depositedSigningKeys for all node operators', async () => {
      const allNodeOperatorsBefore = await nodeOperators.getAllNodeOperators(app)
      await app.onWithdrawalCredentialsChanged({ from: voting })
      const allNodeOperatorsAfter = await nodeOperators.getAllNodeOperators(app)
      for (let i = 0; i < allNodeOperatorsBefore.length; ++i) {
        const nodeOperatorBefore = allNodeOperatorsBefore[i]
        const nodeOperatorAfter = allNodeOperatorsAfter[i]
        assert.equals(nodeOperatorAfter.stakingLimit, nodeOperatorBefore.usedSigningKeys)
        assert.equals(nodeOperatorAfter.totalSigningKeys, nodeOperatorBefore.usedSigningKeys)
      }
    })

    it('emits TotalSigningKeysCountChanged & VettedSigningKeysCountChanged events for node operator only if it had unused keys', async () => {
      const allNodeOperatorsBefore = await nodeOperators.getAllNodeOperators(app)
      const receipt = await app.onWithdrawalCredentialsChanged({ from: voting })
      const allNodeOperatorsAfter = await nodeOperators.getAllNodeOperators(app)
      for (let i = 0; i < allNodeOperatorsBefore.length; ++i) {
        const nodeOperatorBefore = allNodeOperatorsBefore[i]
        const nodeOperatorAfter = allNodeOperatorsAfter[i]
        if (nodeOperatorBefore.totalSigningKeys.toNumber() !== nodeOperatorAfter.usedSigningKeys.toNumber()) {
          assert.emits(receipt, 'TotalSigningKeysCountChanged', {
            nodeOperatorId: i,
            totalValidatorsCount: nodeOperatorAfter.usedSigningKeys
          })
          assert.emits(receipt, 'VettedSigningKeysCountChanged', {
            nodeOperatorId: i,
            approvedValidatorsCount: nodeOperatorAfter.usedSigningKeys
          })
        } else {
          assert.notEmits(receipt, 'TotalSigningKeysCountChanged', { nodeOperatorId: i })
          assert.notEmits(receipt, 'VettedSigningKeysCountChanged', { nodeOperatorId: i })
        }
      }
    })

    it('emits NodeOperatorTotalKeysTrimmed event for node operator only if it had unused keys', async () => {
      const allNodeOperatorsBefore = await nodeOperators.getAllNodeOperators(app)
      const receipt = await app.onWithdrawalCredentialsChanged({ from: voting })
      const allNodeOperatorsAfter = await nodeOperators.getAllNodeOperators(app)
      for (let i = 0; i < allNodeOperatorsBefore.length; ++i) {
        const nodeOperatorBefore = allNodeOperatorsBefore[i]
        const nodeOperatorAfter = allNodeOperatorsAfter[i]
        if (nodeOperatorBefore.totalSigningKeys.toNumber() !== nodeOperatorAfter.usedSigningKeys.toNumber()) {
          assert.emits(receipt, 'NodeOperatorTotalKeysTrimmed', {
            nodeOperatorId: i,
            totalKeysTrimmed:
              nodeOperatorBefore.totalSigningKeys.toNumber() - nodeOperatorAfter.usedSigningKeys.toNumber()
          })
        } else {
          assert.notEmits(receipt, 'NodeOperatorTotalKeysTrimmed', { nodeOperatorId: i })
        }
      }
    })

    it('sets total vetted signing keys count & total signing keys count values to deposited signing keys count', async () => {
      const totalSigningKeysStatsBefore = await app.testing_getTotalSigningKeysStats()
      assert.notEquals(totalSigningKeysStatsBefore.vettedSigningKeysCount, totalSigningKeysStatsBefore.depositedSigningKeysCount)
      assert.notEquals(totalSigningKeysStatsBefore.totalSigningKeysCount, totalSigningKeysStatsBefore.depositedSigningKeysCount)
      await app.onWithdrawalCredentialsChanged({ from: voting })
      const totalSigningKeysStatsAfter = await app.testing_getTotalSigningKeysStats()
      assert.equals(
        totalSigningKeysStatsAfter.vettedSigningKeysCount,
        totalSigningKeysStatsBefore.depositedSigningKeysCount
      )
      assert.equals(
        totalSigningKeysStatsAfter.totalSigningKeysCount,
        totalSigningKeysStatsBefore.depositedSigningKeysCount
      )
    })

    it('increases keysOpIndex & changes nonce', async () => {
      const [keysOpIndexBefore, nonceBefore] = await Promise.all([app.getKeysOpIndex(), app.getNonce()])
      await app.onWithdrawalCredentialsChanged({ from: voting })
      const [keysOpIndexAfter, nonceAfter] = await Promise.all([app.getKeysOpIndex(), app.getNonce()])
      assert.equals(keysOpIndexAfter, keysOpIndexBefore.toNumber() + 1)
      assert.notEquals(nonceAfter, nonceBefore)
    })

    it('emits KeysOpIndexSet & NonceChanged', async () => {
      const keysOpIndexBefore = await app.getKeysOpIndex()
      const receipt = await app.onWithdrawalCredentialsChanged({ from: voting })
      const nonceAfter = await app.getNonce()
      assert.emits(receipt, 'KeysOpIndexSet', { keysOpIndex: keysOpIndexBefore.toNumber() + 1 })
      assert.emits(receipt, 'NonceChanged', { nonce: nonceAfter })
    })

    it("doesn't change validators keys nonce if keys weren't invalidated", async () => {
      // invalidated all keys before the test to remove all unused keys of node operators
      await app.onWithdrawalCredentialsChanged({ from: voting })
      // the second invalidation must not invalidate keys
      const receipt = app.onWithdrawalCredentialsChanged({ from: voting })
      const nonceBefore = await app.getNonce()
      assert.notEmits(receipt, 'NodeOperatorTotalKeysTrimmed')
      const nonceAfter = await app.getNonce()
      assert.equals(nonceBefore, nonceAfter)
    })
  })

  describe('getSigningKeysAllocationData() with target limit', async () => {
    const firstNodeOperatorId = 0
    const secondNodeOperatorId = 1
    beforeEach(async () => {
      await nodeOperators.addNodeOperator(app, { ...NODE_OPERATORS[0], vettedSigningKeysCount: 8 }, { from: voting })
      await nodeOperators.addNodeOperator(app, { ...NODE_OPERATORS[1], depositedSigningKeysCount: 5 }, { from: voting })
    })

    it('_getCorrectedNodeOperator() - deposited < target < vetted', async () => {
      let firstNodeOperatorKeysStats = await app.testing_getCorrectedNodeOperator(firstNodeOperatorId)

      assert.equals(+firstNodeOperatorKeysStats.vettedSigningKeysCount, 8)
      assert.equals(+firstNodeOperatorKeysStats.depositedSigningKeysCount, 5)
      assert.equals(+firstNodeOperatorKeysStats.exitedSigningKeysCount, 1)

      await app.updateTargetValidatorsLimits(firstNodeOperatorId, true, 6, { from: voting })

      firstNodeOperatorKeysStats = await app.testing_getCorrectedNodeOperator(firstNodeOperatorId)
      assert.equals(+firstNodeOperatorKeysStats.vettedSigningKeysCount, 7)
      assert.equals(+firstNodeOperatorKeysStats.depositedSigningKeysCount, 5)
      assert.equals(+firstNodeOperatorKeysStats.exitedSigningKeysCount, 1)
    })

    it('_getCorrectedNodeOperator() - target >= vetted', async () => {
      let firstNodeOperatorKeysStats = await app.testing_getCorrectedNodeOperator(firstNodeOperatorId)

      assert.equals(+firstNodeOperatorKeysStats.vettedSigningKeysCount, 8)
      assert.equals(+firstNodeOperatorKeysStats.depositedSigningKeysCount, 5)
      assert.equals(+firstNodeOperatorKeysStats.exitedSigningKeysCount, 1)

      await app.updateTargetValidatorsLimits(firstNodeOperatorId, true, 1000, { from: voting })

      firstNodeOperatorKeysStats = await app.testing_getCorrectedNodeOperator(firstNodeOperatorId)
      assert.equals(+firstNodeOperatorKeysStats.vettedSigningKeysCount, 8)
      assert.equals(+firstNodeOperatorKeysStats.depositedSigningKeysCount, 5)
      assert.equals(+firstNodeOperatorKeysStats.exitedSigningKeysCount, 1)
    })

    it('_getCorrectedNodeOperator() - target <= deposited-exited', async () => {
      let firstNodeOperatorKeysStats = await app.testing_getCorrectedNodeOperator(firstNodeOperatorId)

      assert.equals(+firstNodeOperatorKeysStats.vettedSigningKeysCount, 8)
      assert.equals(+firstNodeOperatorKeysStats.depositedSigningKeysCount, 5)
      assert.equals(+firstNodeOperatorKeysStats.exitedSigningKeysCount, 1)

      await app.updateTargetValidatorsLimits(firstNodeOperatorId, true, 4, { from: voting })

      firstNodeOperatorKeysStats = await app.testing_getCorrectedNodeOperator(firstNodeOperatorId)
      assert.equals(
        +firstNodeOperatorKeysStats.vettedSigningKeysCount,
        firstNodeOperatorKeysStats.depositedSigningKeysCount
      )
      assert.equals(+firstNodeOperatorKeysStats.depositedSigningKeysCount, 5)
      assert.equals(+firstNodeOperatorKeysStats.exitedSigningKeysCount, 1)
    })

    // it('respects staking limit', async () => {
    //   const [firstNodeOperatorKeysStats, secondNodeOperatorKeysStats] = await Promise.all([
    //     app.getValidatorsKeysStats(firstNodeOperatorId),
    //     app.getValidatorsKeysStats(secondNodeOperatorId)
    //   ])

    //   assert.isTrue(firstNodeOperatorKeysStats.readyToDepositValidatorsKeysCount.toNumber() > 0)
    //   assert.isTrue(secondNodeOperatorKeysStats.readyToDepositValidatorsKeysCount.toNumber() > 0)

    //   assert.equals(firstNodeOperatorKeysStats.exitedValidatorsCount, 1)
    //   assert.equals(firstNodeOperatorKeysStats.activeValidatorsKeysCount, 4)
    //   assert.equals(firstNodeOperatorKeysStats.readyToDepositValidatorsKeysCount, 3)

    //   assert.equals(secondNodeOperatorKeysStats.exitedValidatorsCount, 0)
    //   assert.equals(secondNodeOperatorKeysStats.activeValidatorsKeysCount, 5)
    //   assert.equals(secondNodeOperatorKeysStats.readyToDepositValidatorsKeysCount, 5)

    //   const keysToAllocate = 7
    //   const { allocatedKeysCount, nodeOperatorIds, activeKeyCountsAfterAllocation } =
    //     await app.testing_getSigningKeysAllocationData(keysToAllocate)

    //   assert.equals(allocatedKeysCount, keysToAllocate)
    //   assert.equal(nodeOperatorIds.length, 2)
    //   assert.equals(nodeOperatorIds[0], firstNodeOperatorId)
    //   assert.equals(nodeOperatorIds[1], secondNodeOperatorId)

    //   assert.equal(activeKeyCountsAfterAllocation.length, 2)
    //   // the first node operator has to receive 3 deposits cause reached limit
    //   assert.equals(
    //     activeKeyCountsAfterAllocation[0],
    //     firstNodeOperatorKeysStats.activeValidatorsKeysCount.toNumber() + 3
    //   )
    //   // the second receives 4 deposits
    //   assert.equals(
    //     activeKeyCountsAfterAllocation[1],
    //     secondNodeOperatorKeysStats.activeValidatorsKeysCount.toNumber() + 4
    //   )
    // })
  })

  describe('getSigningKeysAllocationData()', async () => {
    const firstNodeOperatorId = 0
    const secondNodeOperatorId = 1
    beforeEach(async () => {
      await nodeOperators.addNodeOperator(app, { ...NODE_OPERATORS[0], vettedSigningKeysCount: 8 }, { from: voting })
      await nodeOperators.addNodeOperator(app, { ...NODE_OPERATORS[1], depositedSigningKeysCount: 5 }, { from: voting })
    })

    it('returns empty result when registry has no node operators', async () => {
      // clear the registry
      await app.testing_resetRegistry()
      const nodeOperatorsCount = await app.getNodeOperatorsCount()
      assert.equals(nodeOperatorsCount, 0)
      const { allocatedKeysCount, nodeOperatorIds, activeKeyCountsAfterAllocation } =
        await app.testing_getSigningKeysAllocationData(10)
      assert.equals(allocatedKeysCount, 0)
      assert.equal(nodeOperatorIds.length, 0)
      assert.equal(activeKeyCountsAfterAllocation.length, 0)
    })

    it('returns empty result when registry has no active node operators', async () => {
      // deactivate node operators before testing
      await app.deactivateNodeOperator(firstNodeOperatorId, { from: voting })
      await app.deactivateNodeOperator(secondNodeOperatorId, { from: voting })
      const [firstNodeOperator, secondNodeOperator] = await Promise.all([
        app.getNodeOperator(firstNodeOperatorId, false),
        app.getNodeOperator(secondNodeOperatorId, false)
      ])
      assert.isFalse(firstNodeOperator.active)
      assert.isFalse(secondNodeOperator.active)
      const activeNodeOperatorsCount = await app.getActiveNodeOperatorsCount()
      assert.equals(activeNodeOperatorsCount, 0)
      const { allocatedKeysCount, nodeOperatorIds, activeKeyCountsAfterAllocation } =
        await app.testing_getSigningKeysAllocationData(10)
      assert.equals(allocatedKeysCount, 0)
      assert.equal(nodeOperatorIds.length, 0)
      assert.equal(activeKeyCountsAfterAllocation.length, 0)
    })

    it('returns empty result when registry has no unused keys', async () => {
      // remove unused keys
      await app.onWithdrawalCredentialsChanged({ from: voting })
      const [firstNodeOperator, secondNodeOperator] = await Promise.all([
        app.getNodeOperator(firstNodeOperatorId, false),
        app.getNodeOperator(secondNodeOperatorId, false)
      ])
      assert.equals(firstNodeOperator.totalSigningKeys, firstNodeOperator.usedSigningKeys)
      assert.equals(secondNodeOperator.totalSigningKeys, secondNodeOperator.usedSigningKeys)
      const { allocatedKeysCount, nodeOperatorIds, activeKeyCountsAfterAllocation } =
        await app.testing_getSigningKeysAllocationData(10)
      assert.equals(allocatedKeysCount, 0)
      assert.equal(nodeOperatorIds.length, 0)
      assert.equal(activeKeyCountsAfterAllocation.length, 0)
    })

    it('returns empty result when all node operators reached vetted keys limit', async () => {
      // update deposited signing keys count to vetted keys count for all node operators
      await app.testing_markAllKeysDeposited()
      const [firstNodeOperator, secondNodeOperator] = await Promise.all([
        app.getNodeOperator(firstNodeOperatorId, false),
        app.getNodeOperator(secondNodeOperatorId, false)
      ])
      assert.equals(firstNodeOperator.usedSigningKeys, firstNodeOperator.stakingLimit)
      assert.equals(secondNodeOperator.usedSigningKeys, secondNodeOperator.stakingLimit)
      const { allocatedKeysCount, nodeOperatorIds, activeKeyCountsAfterAllocation } =
        await app.testing_getSigningKeysAllocationData(10)
      assert.equals(allocatedKeysCount, 0)
      assert.equal(nodeOperatorIds.length, 0)
      assert.equal(activeKeyCountsAfterAllocation.length, 0)
    })

    it('excludes from result node operators without depositable keys', async () => {
      await app.testing_markAllKeysDeposited(firstNodeOperatorId)
      const [firstNodeOperator, secondNodeOperator] = await Promise.all([
        app.getNodeOperator(firstNodeOperatorId, false),
        app.getNodeOperator(secondNodeOperatorId, false)
      ])

      assert.equals(firstNodeOperator.stakingLimit, firstNodeOperator.usedSigningKeys)
      assert.isTrue(secondNodeOperator.stakingLimit.toNumber() > secondNodeOperator.usedSigningKeys.toNumber())
      const keysToAllocate = 10
      const { allocatedKeysCount, nodeOperatorIds, activeKeyCountsAfterAllocation } =
        await app.testing_getSigningKeysAllocationData(keysToAllocate)

      const secondNodeOperatorReport = await app.getNodeOperatorSummary(secondNodeOperatorId)
      const availableKeysCount = +secondNodeOperatorReport.depositableValidatorsCount

      const expectedAllocatedKeysCount = Math.min(availableKeysCount, keysToAllocate)

      assert.equals(allocatedKeysCount, expectedAllocatedKeysCount)

      assert.equal(nodeOperatorIds.length, 1)
      assert.equal(nodeOperatorIds[0], secondNodeOperatorId)

      assert.equal(activeKeyCountsAfterAllocation.length, 1)
      assert.equal(activeKeyCountsAfterAllocation[0], availableKeysCount + expectedAllocatedKeysCount)

      assert.equals(
        secondNodeOperatorReport.totalExitedValidators,
        NODE_OPERATORS[secondNodeOperatorId].exitedSigningKeysCount
      )
    })

    it('allocates deposits firstly to node operators with min active keys count & with available keys', async () => {
      const [firstNodeOperatorReport, secondNodeOperatorReport] = await Promise.all([
        app.getNodeOperatorSummary(firstNodeOperatorId),
        app.getNodeOperatorSummary(secondNodeOperatorId)
      ])

      const firstNodeOperatorAvailableValidators = +firstNodeOperatorReport.depositableValidatorsCount
      const secondNodeOperatorAvailableValidators = +secondNodeOperatorReport.depositableValidatorsCount

      assert.isTrue(firstNodeOperatorAvailableValidators > 0)
      assert.isTrue(secondNodeOperatorAvailableValidators > 0)

      assert.equals(firstNodeOperatorReport.totalExitedValidators, 1)
      assert.equals(firstNodeOperatorReport.totalDepositedValidators, 5)
      assert.equals(firstNodeOperatorReport.depositableValidatorsCount, 3)

      assert.equals(secondNodeOperatorReport.totalExitedValidators, 0)
      assert.equals(secondNodeOperatorReport.totalDepositedValidators, 5)
      assert.equals(secondNodeOperatorReport.depositableValidatorsCount, 5)

      const keysToAllocate = 3
      const { allocatedKeysCount, nodeOperatorIds, activeKeyCountsAfterAllocation } =
        await app.testing_getSigningKeysAllocationData(keysToAllocate)

      assert.equals(allocatedKeysCount, keysToAllocate)
      assert.equal(nodeOperatorIds.length, 2)
      assert.equals(nodeOperatorIds[0], firstNodeOperatorId)
      assert.equals(nodeOperatorIds[1], secondNodeOperatorId)

      assert.equal(activeKeyCountsAfterAllocation.length, 2)
      // the first node operator has to receive 2 deposits according to the allocation algorithm
      const firstNodeOperatorActiveValidators =
        firstNodeOperatorReport.totalDepositedValidators - firstNodeOperatorReport.totalExitedValidators
      assert.equals(activeKeyCountsAfterAllocation[0], firstNodeOperatorActiveValidators + 2)
      // the second one deposit
      const secondNodeOperatorActiveValidators =
        secondNodeOperatorReport.totalDepositedValidators - secondNodeOperatorReport.totalExitedValidators
      assert.equals(activeKeyCountsAfterAllocation[1], +secondNodeOperatorActiveValidators + 1)
    })

    it("doesn't allocates keys to deactivated node operators", async () => {
      await app.deactivateNodeOperator(firstNodeOperatorId, { from: voting })

      const [firstNodeOperatorReport, secondNodeOperatorReport] = await Promise.all([
        app.getNodeOperatorSummary(firstNodeOperatorId),
        app.getNodeOperatorSummary(secondNodeOperatorId)
      ])

      const firstNodeOperatorAvailableValidators = +firstNodeOperatorReport.depositableValidatorsCount
      const secondNodeOperatorAvailableValidators = +secondNodeOperatorReport.depositableValidatorsCount

      assert.equals(firstNodeOperatorAvailableValidators, 0)
      assert.isTrue(secondNodeOperatorAvailableValidators > 0)

      assert.equals(firstNodeOperatorReport.totalExitedValidators, 1)
      assert.equals(firstNodeOperatorReport.totalDepositedValidators, 5)
      assert.equals(firstNodeOperatorReport.depositableValidatorsCount, 0)

      assert.equals(secondNodeOperatorReport.totalExitedValidators, 0)
      assert.equals(secondNodeOperatorReport.totalDepositedValidators, 5)
      assert.equals(secondNodeOperatorReport.depositableValidatorsCount, 5)

      const keysToAllocate = 3
      const { allocatedKeysCount, nodeOperatorIds, activeKeyCountsAfterAllocation } =
        await app.testing_getSigningKeysAllocationData(keysToAllocate)

      assert.equals(allocatedKeysCount, keysToAllocate)
      assert.equal(nodeOperatorIds.length, 1)
      assert.equals(nodeOperatorIds[0], secondNodeOperatorId)

      assert.equal(activeKeyCountsAfterAllocation.length, 1)
      // the second node operator receives all deposits cause the first is deactivated
      const secondNodeOperatorActiveValidators =
        secondNodeOperatorReport.totalDepositedValidators - secondNodeOperatorReport.totalExitedValidators
      assert.equals(activeKeyCountsAfterAllocation[0].toString(), secondNodeOperatorActiveValidators + keysToAllocate)
    })

    it('respects staking limit', async () => {
      const [firstNodeOperatorReport, secondNodeOperatorReport] = await Promise.all([
        app.getNodeOperatorSummary(firstNodeOperatorId),
        app.getNodeOperatorSummary(secondNodeOperatorId)
      ])

      const firstNodeOperatorAvailableValidators = firstNodeOperatorReport.depositableValidatorsCount
      const secondNodeOperatorAvailableValidators = secondNodeOperatorReport.depositableValidatorsCount

      assert.isTrue(firstNodeOperatorAvailableValidators > 0)
      assert.isTrue(secondNodeOperatorAvailableValidators > 0)

      assert.equals(firstNodeOperatorReport.totalExitedValidators, 1)
      assert.equals(firstNodeOperatorReport.totalDepositedValidators, 5)
      assert.equals(firstNodeOperatorReport.depositableValidatorsCount, 3)

      assert.equals(secondNodeOperatorReport.totalExitedValidators, 0)
      assert.equals(secondNodeOperatorReport.totalDepositedValidators, 5)
      assert.equals(secondNodeOperatorReport.depositableValidatorsCount, 5)

      const keysToAllocate = 7
      const { allocatedKeysCount, nodeOperatorIds, activeKeyCountsAfterAllocation } =
        await app.testing_getSigningKeysAllocationData(keysToAllocate)

      assert.equals(allocatedKeysCount, keysToAllocate)
      assert.equal(nodeOperatorIds.length, 2)
      assert.equals(nodeOperatorIds[0], firstNodeOperatorId)
      assert.equals(nodeOperatorIds[1], secondNodeOperatorId)

      assert.equal(activeKeyCountsAfterAllocation.length, 2)
      // the first node operator has to receive 3 deposits cause reached limit
      const firstNodeOperatorActiveValidators =
        firstNodeOperatorReport.totalDepositedValidators - firstNodeOperatorReport.totalExitedValidators
      assert.equals(activeKeyCountsAfterAllocation[0], firstNodeOperatorActiveValidators + 3)
      // the second receives 4 deposits
      const secondNodeOperatorActiveValidators =
        secondNodeOperatorReport.totalDepositedValidators - secondNodeOperatorReport.totalExitedValidators
      assert.equals(activeKeyCountsAfterAllocation[1], secondNodeOperatorActiveValidators + 4)
    })
  })

  describe('obtainDepositData()', async () => {
    const firstNodeOperatorId = 0
    const secondNodeOperatorId = 1

    beforeEach(async () => {
      await nodeOperators.addNodeOperator(app, NODE_OPERATORS[0], { from: voting })
      await nodeOperators.addNodeOperator(app, NODE_OPERATORS[1], { from: voting })
    })

    it('reverts with error "APP_AUTH_FAILED" when called by sender without STAKING_ROUTER_ROLE', async () => {
      const hasPermission = await dao.hasPermission(nobody, app, 'STAKING_ROUTER_ROLE')
      assert.isFalse(hasPermission)
      await assert.reverts(app.obtainDepositData(10, '0x', { from: nobody }), 'APP_AUTH_FAILED')
    })

    it('returns empty result when no validators to deposit to', async () => {
      // clear the registry to remove all unused keys with node operators
      await app.testing_resetRegistry()
      const nodeOperatorsCount = await app.getNodeOperatorsCount()
      assert.equals(nodeOperatorsCount, 0)
      const keysToAllocate = 10
      const receipt = await app.testing_obtainDepositData(keysToAllocate)
      const keysLoadedEvent = getEventAt(receipt, 'ValidatorsKeysLoaded').args
      assert.equals(keysLoadedEvent.count, 0)
      assert.isNull(keysLoadedEvent.publicKeys)
      assert.isNull(keysLoadedEvent.signatures)
    })

    it("doesn't change validators keys nonce when no available keys for deposit", async () => {
      // deactivate node operators before testing to remove available keys
      await app.deactivateNodeOperator(firstNodeOperatorId, { from: voting })
      await app.deactivateNodeOperator(secondNodeOperatorId, { from: voting })
      const activeNodeOperatorsCount = await app.getActiveNodeOperatorsCount()
      assert.equals(activeNodeOperatorsCount, 0)

      const nonceBefore = await app.getNonce()
      const keysToAllocate = 10
      await app.testing_obtainDepositData(keysToAllocate)
      const nonceAfter = await app.getNonce()
      assert.equals(nonceBefore, nonceAfter)
    })

    it("doesn't emits DepositedSigningKeysCountChanged when no available keys for deposit", async () => {
      // remove unused keys
      await app.onWithdrawalCredentialsChanged({ from: voting })
      const [firstNodeOperator, secondNodeOperator] = await Promise.all([
        app.getNodeOperator(firstNodeOperatorId, false),
        app.getNodeOperator(secondNodeOperatorId, false)
      ])
      assert.equals(firstNodeOperator.totalSigningKeys, firstNodeOperator.usedSigningKeys)
      assert.equals(secondNodeOperator.totalSigningKeys, secondNodeOperator.usedSigningKeys)

      const keysToAllocate = 10
      const receipt = await app.testing_obtainDepositData(keysToAllocate)
      assert.notEmits(receipt, 'DepositedSigningKeysCountChanged')
    })

    it('loads correct signing keys', async () => {
      // clear the registry to remove all unused keys with node operators
      await app.testing_resetRegistry()

      await app.addNodeOperator('fo o', ADDRESS_1, { from: voting })
      await app.addNodeOperator(' bar', ADDRESS_2, { from: voting })

      const firstOperatorKeys = new signingKeys.FakeValidatorKeys(3)
      const secondOperatorKeys = new signingKeys.FakeValidatorKeys(3)

      await app.addSigningKeys(0, 3, ...firstOperatorKeys.slice(), { from: voting })
      await app.addSigningKeys(1, 3, ...secondOperatorKeys.slice(), { from: voting })

      await app.setNodeOperatorStakingLimit(0, 10, { from: voting })
      await app.setNodeOperatorStakingLimit(1, 10, { from: voting })

      let keysToAllocate = 1
      let receipt = await app.testing_obtainDepositData(keysToAllocate)
      let keysLoadedEvent = getEventAt(receipt, 'ValidatorsKeysLoaded').args

      assert.equal(keysLoadedEvent.publicKeys, firstOperatorKeys.get(0)[0], 'assignment 1: pubkeys')
      assert.equal(keysLoadedEvent.signatures, firstOperatorKeys.get(0)[1], 'assignment 1: signatures')

      keysToAllocate = 2
      receipt = await app.testing_obtainDepositData(keysToAllocate)
      keysLoadedEvent = getEventAt(receipt, 'ValidatorsKeysLoaded').args

      assert.sameMembers(
        signingKeys.splitPublicKeysBatch(keysLoadedEvent.publicKeys),
        [firstOperatorKeys.get(1)[0], secondOperatorKeys.get(0)[0]],
        'assignment 2: publicKeys'
      )

      assert.sameMembers(
        signingKeys.splitSignaturesBatch(keysLoadedEvent.signatures),
        [firstOperatorKeys.get(1)[1], secondOperatorKeys.get(0)[1]],
        'assignment 2: signatures'
      )

      keysToAllocate = 10
      receipt = await app.testing_obtainDepositData(keysToAllocate)
      keysLoadedEvent = getEventAt(receipt, 'ValidatorsKeysLoaded').args

      assert.sameMembers(
        signingKeys.splitPublicKeysBatch(keysLoadedEvent.publicKeys),
        [firstOperatorKeys.get(2)[0], secondOperatorKeys.get(1)[0], secondOperatorKeys.get(2)[0]],
        'assignment 2: publicKeys'
      )
      assert.sameMembers(
        signingKeys.splitSignaturesBatch(keysLoadedEvent.signatures),
        [firstOperatorKeys.get(2)[1], secondOperatorKeys.get(1)[1], secondOperatorKeys.get(2)[1]],
        'assignment 2: signatures'
      )

      keysToAllocate = 10
      receipt = await app.testing_obtainDepositData(keysToAllocate)
      keysLoadedEvent = getEventAt(receipt, 'ValidatorsKeysLoaded').args

      assert.equal(keysLoadedEvent.publicKeys, null, 'no singing keys left: publicKeys')
      assert.equal(keysLoadedEvent.signatures, null, 'no singing keys left: signatures')
    })

    it('increases keysOpIndex & changes nonce', async () => {
      const [keysOpIndexBefore, nonceBefore] = await Promise.all([app.getKeysOpIndex(), app.getNonce()])
      const keysToAllocate = 10
      await app.testing_obtainDepositData(keysToAllocate)
      const [keysOpIndexAfter, nonceAfter] = await Promise.all([app.getKeysOpIndex(), app.getNonce()])
      assert.equals(keysOpIndexAfter, keysOpIndexBefore.toNumber() + 1)
      assert.notEquals(nonceAfter, nonceBefore)
    })

    it('increases global deposited signing keys counter', async () => {
      const keysToAllocate = 10
      const keyIndex = NODE_OPERATORS[secondNodeOperatorId].depositedSigningKeysCount + 1
      assert.isTrue(keyIndex <= NODE_OPERATORS[secondNodeOperatorId].totalSigningKeysCount)
      const { depositedSigningKeysCount: depositedSigningKeysCountBefore } = await app.testing_getTotalSigningKeysStats()
      await app.testing_obtainDepositData(keysToAllocate)
      const { depositedSigningKeysCount: depositedSigningKeysCountAfter } = await app.testing_getTotalSigningKeysStats()
      assert.equal(depositedSigningKeysCountAfter.toNumber(), depositedSigningKeysCountBefore.toNumber() + 4)
    })

    it('emits KeysOpIndexSet & NonceChanged', async () => {
      const keysOpIndexBefore = await app.getKeysOpIndex()
      const keysToAllocate = 10
      const receipt = await app.testing_obtainDepositData(keysToAllocate)
      const nonceAfter = await app.getNonce()
      assert.emits(receipt, 'KeysOpIndexSet', { keysOpIndex: keysOpIndexBefore.toNumber() + 1 })
      assert.emits(receipt, 'NonceChanged', { nonce: nonceAfter })
    })

    it('emits DepositedSigningKeysCountChanged when keys were loaded', async () => {
      let keysToAllocate = 2
      let receipt = await app.testing_obtainDepositData(keysToAllocate)
      assert.emits(receipt, 'DepositedSigningKeysCountChanged', { nodeOperatorId: firstNodeOperatorId, depositedValidatorsCount: 6 })
      assert.emits(receipt, 'DepositedSigningKeysCountChanged', { nodeOperatorId: secondNodeOperatorId, depositedValidatorsCount: 8 })

      keysToAllocate = 10
      receipt = await app.testing_obtainDepositData(keysToAllocate)
      assert.notEmits(receipt, 'DepositedSigningKeysCountChanged', { nodeOperatorId: firstNodeOperatorId, depositedSigningKeysCount: 6 })
      assert.emits(receipt, 'DepositedSigningKeysCountChanged', { nodeOperatorId: secondNodeOperatorId, depositedValidatorsCount: 10 })
    })
  })

  describe('getNodeOperator()', () => {
    const firstNodeOperatorId = 0
    const secondNodeOperatorId = 1
    const notExistedNodeOperatorId = 2
    beforeEach(async () => {
      await nodeOperators.addNodeOperator(app, NODE_OPERATORS[0], { from: voting })
      await nodeOperators.addNodeOperator(app, NODE_OPERATORS[1], { from: voting })
    })

    it('reverts with "OUT_OF_RANGE" error when called on non existent validator', async () => {
      const hasPermission = await dao.hasPermission(voting, app, 'STAKING_ROUTER_ROLE')
      assert.isTrue(hasPermission)
      await assert.reverts(app.getNodeOperator(notExistedNodeOperatorId, false, { from: voting }), 'OUT_OF_RANGE')
    })

    it('returns correct node operator info', async () => {
      const nodeOperator = await app.getNodeOperator(secondNodeOperatorId, true)
      assert.equal(nodeOperator.active, NODE_OPERATORS[secondNodeOperatorId].isActive !== false)
      assert.equal(nodeOperator.name, NODE_OPERATORS[secondNodeOperatorId].name)
      assert.equal(nodeOperator.rewardAddress, NODE_OPERATORS[secondNodeOperatorId].rewardAddress)
      assert.equals(nodeOperator.stakingLimit, NODE_OPERATORS[secondNodeOperatorId].vettedSigningKeysCount)
      assert.equals(nodeOperator.stoppedValidators, NODE_OPERATORS[secondNodeOperatorId].exitedSigningKeysCount)
      assert.equals(nodeOperator.totalSigningKeys, NODE_OPERATORS[secondNodeOperatorId].totalSigningKeysCount)
      assert.equals(nodeOperator.usedSigningKeys, NODE_OPERATORS[secondNodeOperatorId].depositedSigningKeysCount)
    })

    it('returns empty name when _fullInfo is false', async () => {
      const nodeOperatorWithoutName = await app.getNodeOperator(firstNodeOperatorId, false)
      assert.equal(nodeOperatorWithoutName.name, '')
      const nodeOperatorWithName = await app.getNodeOperator(firstNodeOperatorId, true)
      assert.isTrue(nodeOperatorWithName.name !== '')
    })
  })

  describe('getRewardsDistribution()', () => {
    const firstNodeOperatorId = 0
    const secondNodeOperatorId = 1

    beforeEach(async () => {
      await nodeOperators.addNodeOperator(app, NODE_OPERATORS[0], { from: voting })
      await nodeOperators.addNodeOperator(app, NODE_OPERATORS[1], { from: voting })
      await nodeOperators.addNodeOperator(app, NODE_OPERATORS[2], { from: voting })
    })

    it('returns empty data when no node operators', async () => {
      // clear the registry from node operators
      await app.testing_resetRegistry()
      const totalRewardsShare = web3.utils.toWei('10')
      const { recipients, shares } = await app.getRewardsDistribution(totalRewardsShare)
      assert.isEmpty(recipients)
      assert.isEmpty(shares)
    })

    it('returns empty data when all node operators are deactivated', async () => {
      await app.deactivateNodeOperator(firstNodeOperatorId, { from: voting })
      await app.deactivateNodeOperator(secondNodeOperatorId, { from: voting })

      const totalRewardsShare = web3.utils.toWei('10')
      const { recipients, shares } = await app.getRewardsDistribution(totalRewardsShare)
      assert.isEmpty(shares)
      assert.isEmpty(recipients)
    })

    it('returns zero shares when all validators are exited', async () => {
      await app.updateExitedValidatorsCount(firstNodeOperatorId, NODE_OPERATORS[firstNodeOperatorId].depositedSigningKeysCount, {
        from: voting
      })
      await app.updateExitedValidatorsCount(secondNodeOperatorId, NODE_OPERATORS[secondNodeOperatorId].depositedSigningKeysCount, {
        from: voting
      })
      const activeNodeOperators = await nodeOperators.filterNodeOperators(app, (nodeOperator) => nodeOperator.active)
      const totalRewardsShare = web3.utils.toWei('10')
      const { recipients, shares } = await app.getRewardsDistribution(totalRewardsShare)
      assert.equal(shares.length, activeNodeOperators.length)
      shares.forEach((s) => assert.equals(s, 0))
      assert.equal(recipients.length, activeNodeOperators.length)
      recipients.forEach((rewardAddress, i) => assert.equals(rewardAddress, activeNodeOperators[i].rewardAddress))
    })

    it('correctly counts rewards distribution', async () => {
      const totalRewardsShare = BigInt(10 ** 19)
      const activeNodeOperators = await nodeOperators.filterNodeOperators(app, (nodeOperator) => nodeOperator.active)
      const { recipients, shares } = await app.getRewardsDistribution(totalRewardsShare.toString())

      assert.equal(recipients.length, activeNodeOperators.length)
      recipients.forEach((rewardAddress, i) => assert.equals(rewardAddress, activeNodeOperators[i].rewardAddress))

      const totalActiveNodeOperators = NODE_OPERATORS.reduce(
        (sum, n) => (n.isActive === false ? sum : sum + BigInt(n.depositedSigningKeysCount - n.exitedSigningKeysCount)),
        0n
      )

      const perValidatorReward = totalRewardsShare / totalActiveNodeOperators
      const expectedRewardsDistribution = NODE_OPERATORS.filter((n) => n.isActive !== false).map((n) =>
        n.isActive === false ? 0n : perValidatorReward * BigInt(n.depositedSigningKeysCount - n.exitedSigningKeysCount)
      )
      assert.equal(shares.length, expectedRewardsDistribution.length)
      for (let i = 0; i < shares.length; ++i) {
        assert.equals(shares[i], expectedRewardsDistribution[i])
      }
    })
  })

  describe('addSigningKeys()', () => {
    const firstNodeOperatorId = 0
    const firstNodeOperatorKeys = new signingKeys.FakeValidatorKeys(5)
    const secondNodeOperatorId = 1
    const secondNodeOperatorKeys = new signingKeys.FakeValidatorKeys(7)
    const nonExistentNodeOperatorId = 3

    beforeEach(async () => {
      await nodeOperators.addNodeOperator(app, { name: '1', rewardAddress: ADDRESS_1 }, { from: voting })
      await nodeOperators.addNodeOperator(app, { name: '2', rewardAddress: ADDRESS_2 }, { from: voting })
    })

    it('reverts with APP_AUTH_FAILED error when called by sender without MANAGE_SIGNING_KEYS role', async () => {
      const hasPermission = await dao.hasPermission(nobody, app, 'MANAGE_SIGNING_KEYS')
      assert.isFalse(hasPermission)
      const keysCount = 3
      const [publicKeys, signatures] = firstNodeOperatorKeys.slice(0, keysCount)
      await assert.reverts(
        app.addSigningKeys(firstNodeOperatorId, keysCount, publicKeys, signatures, { from: nobody }),
        'APP_AUTH_FAILED'
      )
    })

    it('reverts with OUT_OF_RANGE error when keys count > UINT64_MAX', async () => {
      const keysCount = toBN('0x10000000000000000')
      await assert.reverts(
        app.addSigningKeys(secondNodeOperatorId, keysCount, '0x', '0x', { from: voting }),
        'OUT_OF_RANGE'
      )
    })

    it('reverts with "OUT_OF_RANGE" error when called on non existent validator', async () => {
      const keysCount = firstNodeOperatorKeys.count
      const [publicKeys, signatures] = firstNodeOperatorKeys.slice()
      await assert.reverts(
        app.addSigningKeys(nonExistentNodeOperatorId, keysCount, publicKeys, signatures, { from: voting }),
        'OUT_OF_RANGE'
      )
    })

    it('reverts with "OUT_OF_RANGE" error when keys count is 0', async () => {
      const keysCount = 0
      await assert.reverts(
        app.addSigningKeys(firstNodeOperatorId, keysCount, '0x', '0x', { from: voting }),
        'OUT_OF_RANGE'
      )
    })

    it('reverts with "INVALID_LENGTH" error when public keys batch has invalid length', async () => {
      const keysCount = 2
      const [publicKeys, signatures] = secondNodeOperatorKeys.slice(0, keysCount)
      await assert.reverts(
        app.addSigningKeys(firstNodeOperatorId, keysCount, publicKeys + 'deadbeaf', signatures, { from: voting }),
        'INVALID_LENGTH'
      )
    })

    it('reverts with "INVALID_LENGTH" error when signatures batch has invalid length', async () => {
      const keysCount = 2
      const [publicKeys, signatures] = secondNodeOperatorKeys.slice(0, keysCount)
      await assert.reverts(
        app.addSigningKeys(firstNodeOperatorId, keysCount, publicKeys, signatures.slice(0, -2), { from: voting }),
        'INVALID_LENGTH'
      )
    })

    it('reverts with "INVALID_LENGTH" error when public keys and signatures length mismatch', async () => {
      const keysCount = 2
      const [publicKeys] = secondNodeOperatorKeys.slice(0, keysCount)
      const [, signatures] = secondNodeOperatorKeys.slice(0, keysCount + 1)
      await assert.reverts(
        app.addSigningKeys(firstNodeOperatorId, keysCount, publicKeys, signatures.slice(0, -2), { from: voting }),
        'INVALID_LENGTH'
      )
    })

    it('reverts with "EMPTY_KEY" error when public key is zero bytes batch', async () => {
      const keysCount = 1
      const [, signature] = firstNodeOperatorKeys.get(0)
      await assert.reverts(
        app.addSigningKeys(firstNodeOperatorId, keysCount, signingKeys.EMPTY_PUBLIC_KEY, signature, { from: voting }),
        'EMPTY_KEY'
      )
    })

    it('increases node operator total signing keys counter correctly', async () => {
      const { totalSigningKeys: totalSigningKeysCountBefore } = await app.getNodeOperator(firstNodeOperatorId, false)
      await app.addSigningKeys(firstNodeOperatorId, firstNodeOperatorKeys.count, ...firstNodeOperatorKeys.slice(), {
        from: voting
      })
      const { totalSigningKeys: totalSigningKeysCountAfter } = await app.getNodeOperator(firstNodeOperatorId, false)
      assert.equal(
        totalSigningKeysCountAfter.toNumber(),
        totalSigningKeysCountBefore.toNumber() + firstNodeOperatorKeys.count
      )
    })

    it("doesn't modify total signing keys counter of other node operators", async () => {
      const { totalSigningKeys: totalSigningKeysCountBefore } = await app.getNodeOperator(secondNodeOperatorId, false)
      await app.addSigningKeys(firstNodeOperatorId, firstNodeOperatorKeys.count, ...firstNodeOperatorKeys.slice(), {
        from: voting
      })
      const { totalSigningKeys: totalSigningKeysCountAfter } = await app.getNodeOperator(secondNodeOperatorId, false)
      assert.equals(totalSigningKeysCountBefore, totalSigningKeysCountAfter)
    })

    it('stores keys correctly for node operator without keys', async () => {
      await app.addSigningKeys(secondNodeOperatorId, secondNodeOperatorKeys.count, ...secondNodeOperatorKeys.slice(), {
        from: voting
      })
      for (let i = 0; i < secondNodeOperatorKeys.count; ++i) {
        const { key, depositSignature } = await app.getSigningKey(secondNodeOperatorId, i)
        const [expectedPublicKey, expectedSignature] = secondNodeOperatorKeys.get(i)
        assert.equal(key, expectedPublicKey)
        assert.equal(depositSignature, expectedSignature)
      }
    })

    it('stores keys correctly for node operator with keys', async () => {
      const initialKeysCount = 2
      await app.addSigningKeys(
        firstNodeOperatorId,
        initialKeysCount,
        ...firstNodeOperatorKeys.slice(0, initialKeysCount),
        { from: voting }
      )
      await app.addSigningKeys(
        firstNodeOperatorId,
        firstNodeOperatorKeys.count - initialKeysCount,
        ...firstNodeOperatorKeys.slice(2),
        {
          from: voting
        }
      )
      for (let i = initialKeysCount; i < firstNodeOperatorKeys.count; ++i) {
        const { key, depositSignature } = await app.getSigningKey(firstNodeOperatorId, i)
        const [expectedPublicKey, expectedSignature] = firstNodeOperatorKeys.get(i)
        assert.equal(key, expectedPublicKey)
        assert.equal(depositSignature, expectedSignature)
      }
    })

    it("doesn't modify the keys of other node operators", async () => {
      await app.addSigningKeys(firstNodeOperatorId, firstNodeOperatorKeys.count, ...firstNodeOperatorKeys.slice(), {
        from: voting
      })
      await app.addSigningKeys(secondNodeOperatorId, secondNodeOperatorKeys.count, ...secondNodeOperatorKeys.slice(), {
        from: voting
      })
      for (let i = 0; i < firstNodeOperatorKeys.count; ++i) {
        const { key, depositSignature } = await app.getSigningKey(firstNodeOperatorId, i)
        const [expectedPublicKey, expectedSignature] = firstNodeOperatorKeys.get(i)
        assert.equal(key, expectedPublicKey)
        assert.equal(depositSignature, expectedSignature)
      }
    })

    it('increases global total signing keys counter correctly', async () => {
      await app.addSigningKeys(secondNodeOperatorId, secondNodeOperatorKeys.count, ...secondNodeOperatorKeys.slice(), {
        from: voting
      })
      const { totalSigningKeysCount: totalSigningKeysCountBefore } = await app.testing_getTotalSigningKeysStats()
      await app.addSigningKeys(firstNodeOperatorId, firstNodeOperatorKeys.count, ...firstNodeOperatorKeys.slice(), {
        from: voting
      })
      const { totalSigningKeysCount: totalSigningKeysCountAfter } = await app.testing_getTotalSigningKeysStats()
      assert.equal(totalSigningKeysCountAfter, totalSigningKeysCountBefore.toNumber() + firstNodeOperatorKeys.count)
    })

    it('increases keysOpIndex & changes nonce', async () => {
      const [keysOpIndexBefore, nonceBefore] = await Promise.all([app.getKeysOpIndex(), app.getNonce()])
      await app.addSigningKeys(firstNodeOperatorId, firstNodeOperatorKeys.count, ...firstNodeOperatorKeys.slice(), { from: voting })
      const [keysOpIndexAfter, nonceAfter] = await Promise.all([app.getKeysOpIndex(), app.getNonce()])
      assert.equals(keysOpIndexAfter, keysOpIndexBefore.toNumber() + 1)
      assert.notEquals(nonceAfter, nonceBefore)
    })

    it('emits KeysOpIndexSet & NonceChanged', async () => {
      const keysOpIndexBefore = await app.getKeysOpIndex()
      const receipt = await app.addSigningKeys(firstNodeOperatorId, firstNodeOperatorKeys.count, ...firstNodeOperatorKeys.slice(), {
        from: voting
      })
      const nonceAfter = await app.getNonce()
      assert.emits(receipt, 'KeysOpIndexSet', { keysOpIndex: keysOpIndexBefore.toNumber() + 1 })
      assert.emits(receipt, 'NonceChanged', { nonce: nonceAfter })
    })

    it('emits SigningKeyAdded with correct params for every added key', async () => {
      const receipt = await app.addSigningKeys(
        firstNodeOperatorId,
        firstNodeOperatorKeys.count,
        ...firstNodeOperatorKeys.slice(),
        {
          from: voting
        }
      )
      for (let i = 0; i < firstNodeOperatorKeys.count; ++i) {
        assert.emits(
          receipt,
          'SigningKeyAdded',
          { nodeOperatorId: firstNodeOperatorId, pubkey: firstNodeOperatorKeys.get(i)[0] },
          { abi: SigningKeys._json.abi }
        )
      }
    })

    it('emits TotalSigningKeysCountChanged event with correct params', async () => {
      const receipt = await app.addSigningKeys(
        secondNodeOperatorId,
        secondNodeOperatorKeys.count,
        ...secondNodeOperatorKeys.slice(),
        {
          from: voting
        }
      )
      assert.emits(receipt, 'TotalSigningKeysCountChanged', {
        nodeOperatorId: secondNodeOperatorId,
        totalValidatorsCount: secondNodeOperatorKeys.count
      })
    })
  })

  describe('addSigningKeysOperatorBH()', () => {
    const firstNodeOperatorId = 0
    const firstNodeOperatorKeys = new signingKeys.FakeValidatorKeys(1)

    beforeEach(async () => {
      await nodeOperators.addNodeOperator(app, { name: '1', rewardAddress: user1 }, { from: voting })
    })

    it('reverts with APP_AUTH_FAILED error when called not by reward address', async () => {
      await assert.reverts(
        app.addSigningKeysOperatorBH(
          firstNodeOperatorId,
          firstNodeOperatorKeys.count,
          ...firstNodeOperatorKeys.slice(),
          {
            from: user2
          }
        ),
        'APP_AUTH_FAILED'
      )
    })

    it('reverts with OUT_OF_RANGE error when keys count > UINT64_MAX', async () => {
      const keysCount = toBN('0x10000000000000000')
      await assert.reverts(
        app.addSigningKeysOperatorBH(firstNodeOperatorId, keysCount, '0x', '0x', { from: user1 }),
        'OUT_OF_RANGE'
      )
    })

    it('stores keys correctly', async () => {
      await app.addSigningKeysOperatorBH(
        firstNodeOperatorId,
        firstNodeOperatorKeys.count,
        ...firstNodeOperatorKeys.slice(),
        {
          from: user1
        }
      )
      for (let i = 0; i < firstNodeOperatorKeys.count; ++i) {
        const { key, depositSignature } = await app.getSigningKey(firstNodeOperatorId, i)
        const [expectedPublicKey, expectedSignature] = firstNodeOperatorKeys.get(i)
        assert.equal(key, expectedPublicKey)
        assert.equal(depositSignature, expectedSignature)
      }
    })
  })

  describe('removeSigningKey()', async () => {
    const firstNodeOperatorId = 0
    const secondNodeOperatorId = 1
    const nonExistentNodeOperatorId = 3
    let firstNodeOperatorKeys, secondNodeOperatorKeys

    beforeEach(async () => {
      await nodeOperators
        .addNodeOperator(app, NODE_OPERATORS[0], { from: voting })
        .then((r) => (firstNodeOperatorKeys = r.validatorKeys))
      await nodeOperators
        .addNodeOperator(app, NODE_OPERATORS[1], { from: voting })
        .then((r) => (secondNodeOperatorKeys = r.validatorKeys))
    })

    it('reverts with "OUT_OF_RANGE" error when called on non existent validator', async () => {
      await assert.reverts(app.removeSigningKey(nonExistentNodeOperatorId, 0, { from: voting }), 'OUT_OF_RANGE')
    })

    it('reverts with APP_AUTH_FAILED error when called by sender without MANAGE_SIGNING_KEYS role', async () => {
      const hasPermission = await dao.hasPermission(nobody, app, 'STAKING_ROUTER_ROLE')
      assert.isFalse(hasPermission)
      const keyIndex = firstNodeOperatorKeys.count - 1
      await assert.reverts(app.removeSigningKey(firstNodeOperatorId, keyIndex, { from: nobody }), 'APP_AUTH_FAILED')
    })

    it('reverts with OUT_OF_RANGE error when index greater than UINT64_MAX', async () => {
      const keyIndex = toBN('0x10000000000000000')
      await assert.reverts(app.removeSigningKey(firstNodeOperatorId, keyIndex, { from: voting }), 'OUT_OF_RANGE')
    })

    it('reverts with OUT_OF_RANGE error when index is greater than total signing keys count', async () => {
      const keyIndex = NODE_OPERATORS[secondNodeOperatorId].totalSigningKeysCount
      await assert.reverts(app.removeSigningKey(secondNodeOperatorId, keyIndex, { from: voting }), 'OUT_OF_RANGE')
    })

    it('reverts with OUT_OF_RANGE error when key with passed index was deposited', async () => {
      const keyIndex = NODE_OPERATORS[firstNodeOperatorId].depositedSigningKeysCount - 1
      assert(keyIndex >= 0)
      await assert.reverts(app.removeSigningKey(firstNodeOperatorId, keyIndex, { from: voting }), 'OUT_OF_RANGE')
    })

    it('decreases total signing keys counter for node operator', async () => {
      const keyIndex = NODE_OPERATORS[secondNodeOperatorId].depositedSigningKeysCount
      assert.isTrue(keyIndex <= NODE_OPERATORS[secondNodeOperatorId].totalSigningKeysCount)
      const { totalSigningKeys: totalSigningKeysBefore } = await app.getNodeOperator(secondNodeOperatorId, false)
      await app.removeSigningKey(secondNodeOperatorId, keyIndex, { from: voting })
      const { totalSigningKeys: totalSigningKeysAfter } = await app.getNodeOperator(secondNodeOperatorId, false)
      assert.equal(totalSigningKeysAfter.toNumber(), totalSigningKeysBefore.toNumber() - 1)
    })

    it('decreases global total signing keys counter', async () => {
      const keyIndex = NODE_OPERATORS[secondNodeOperatorId].depositedSigningKeysCount + 1
      assert.isTrue(keyIndex <= NODE_OPERATORS[secondNodeOperatorId].totalSigningKeysCount)
      const { totalSigningKeysCount: totalSigningKeysCountBefore } = await app.testing_getTotalSigningKeysStats()
      await app.removeSigningKey(secondNodeOperatorId, keyIndex, { from: voting })
      const { totalSigningKeysCount: totalSigningKeysCountAfter } = await app.testing_getTotalSigningKeysStats()
      assert.equal(totalSigningKeysCountAfter.toNumber(), totalSigningKeysCountBefore.toNumber() - 1)
    })

    it("doesn't change vetted signing keys counter if it greater than vetted keys counter", async () => {
      const keyIndex = NODE_OPERATORS[firstNodeOperatorId].vettedSigningKeysCount + 1
      assert.isTrue(keyIndex <= NODE_OPERATORS[firstNodeOperatorId].totalSigningKeysCount)
      const { stakingLimit: stakingLimitBefore } = await app.getNodeOperator(firstNodeOperatorId, false)
      await app.removeSigningKey(firstNodeOperatorId, keyIndex, { from: voting })
      const { stakingLimit: stakingLimitAfter } = await app.getNodeOperator(firstNodeOperatorId, false)
      assert.equals(stakingLimitBefore, stakingLimitAfter)
    })

    it("doesn't change vetted signing keys counter if it equal to vetted keys counter", async () => {
      const keyIndex = NODE_OPERATORS[firstNodeOperatorId].vettedSigningKeysCount
      assert.isTrue(keyIndex <= NODE_OPERATORS[firstNodeOperatorId].totalSigningKeysCount)
      const { stakingLimit: stakingLimitBefore } = await app.getNodeOperator(firstNodeOperatorId, false)
      await app.removeSigningKey(firstNodeOperatorId, keyIndex, { from: voting })
      const { stakingLimit: stakingLimitAfter } = await app.getNodeOperator(firstNodeOperatorId, false)
      assert.equals(stakingLimitBefore, stakingLimitAfter)
    })

    it('sets vetted signing keys counter equal to passed key index if it less than vetted keys counter', async () => {
      const keyIndex = NODE_OPERATORS[secondNodeOperatorId].vettedSigningKeysCount - 1
      assert.isTrue(keyIndex <= NODE_OPERATORS[secondNodeOperatorId].totalSigningKeysCount)
      await app.removeSigningKey(secondNodeOperatorId, keyIndex, { from: voting })
      const { stakingLimit: stakingLimitAfter } = await app.getNodeOperator(secondNodeOperatorId, false)
      assert.equal(stakingLimitAfter.toNumber(), keyIndex)
    })

    it('correctly decreases global vetted signing keys count if key index is less then vetted keys counter of node operator', async () => {
      const keyIndex = NODE_OPERATORS[secondNodeOperatorId].vettedSigningKeysCount - 1
      assert.isTrue(keyIndex <= NODE_OPERATORS[secondNodeOperatorId].totalSigningKeysCount)
      const { vettedSigningKeysCount: vettedSigningKeysCountBefore } = await app.testing_getTotalSigningKeysStats()
      await app.removeSigningKey(secondNodeOperatorId, keyIndex, { from: voting })
      const { vettedSigningKeysCount: vettedSigningKeysCountAfter } = await app.testing_getTotalSigningKeysStats()
      const vettedSigningKeysDecrement = NODE_OPERATORS[secondNodeOperatorId].vettedSigningKeysCount - keyIndex
      assert.equal(
        vettedSigningKeysCountAfter.toNumber(),
        vettedSigningKeysCountBefore.toNumber() - vettedSigningKeysDecrement
      )
    })

    // it.only('correctly decreases global vetted signing keys and totalTargetStats count if key index is less then vetted keys counter of node operator', async () => {
    //   const keyIndex = NODE_OPERATORS[secondNodeOperatorId].vettedSigningKeysCount - 1
    //   assert.isTrue(keyIndex <= NODE_OPERATORS[secondNodeOperatorId].totalSigningKeysCount)
    //   const { vettedSigningKeysCount: vettedSigningKeysCountBefore } = await app.testing_getTotalSigningKeysStats()

    //   const {
    //     isTargetLimitActive: isTargetLimitActiveBefore,
    //     targetValidatorsCount: targetValidatorsCountBefore,
    //     excessValidatorsCount: excessValidatorsCountBefore,
    //   } = await app.testing_getTotalTargetStats();

    //   // await app.updateTargetValidatorsLimits(secondNodeOperatorId,  true, 2, { from: voting })

    //   await app.removeSigningKey(secondNodeOperatorId, keyIndex, { from: voting })

    //   const { vettedSigningKeysCount: vettedSigningKeysCountAfter } = await app.testing_getTotalSigningKeysStats()
    //   const vettedSigningKeysDecrement = NODE_OPERATORS[secondNodeOperatorId].vettedSigningKeysCount - keyIndex
    //   assert.equal(
    //     vettedSigningKeysCountAfter.toNumber(),
    //     vettedSigningKeysCountBefore.toNumber() - vettedSigningKeysDecrement
    //   )

    //   const {
    //     isTargetLimitActive: isTargetLimitActiveAfter,
    //     targetValidatorsCount: targetValidatorsCountAfter,
    //     excessValidatorsCount: excessValidatorsCountAfter,
    //   } = await app.testing_getTotalTargetStats();

    //   console.log({
    //     targetValidatorsCountBefore: targetValidatorsCountBefore.toNumber(),
    //     targetValidatorsCountAfter: targetValidatorsCountAfter.toNumber(),
    //     vettedSigningKeysCountBefore: vettedSigningKeysCountBefore.toNumber() ,
    //     vettedSigningKeysDecrement

    //   })

    //   assertBn(isTargetLimitActiveAfter, isTargetLimitActiveBefore)
    //   assertBn(targetValidatorsCountAfter, targetValidatorsCountBefore.toNumber() - vettedSigningKeysCountBefore.toNumber() - vettedSigningKeysDecrement)
    //   assertBn(excessValidatorsCountAfter, excessValidatorsCountBefore)
    // })

    it("doesn't modify global vetted signing keys count if key index is equal to vettedSigningKeysCount", async () => {
      const keyIndex = NODE_OPERATORS[secondNodeOperatorId].vettedSigningKeysCount
      assert.isTrue(keyIndex <= NODE_OPERATORS[secondNodeOperatorId].totalSigningKeysCount)
      const { vettedSigningKeysCount: vettedSigningKeysCountBefore } = await app.testing_getTotalSigningKeysStats()
      await app.removeSigningKey(secondNodeOperatorId, keyIndex, { from: voting })
      const { vettedSigningKeysCount: vettedSigningKeysCountAfter } = await app.testing_getTotalSigningKeysStats()
      assert.equals(vettedSigningKeysCountAfter, vettedSigningKeysCountBefore)
    })

    it("doesn't modify global vetted signing keys count if key index is greater than vettedSigningKeysCount", async () => {
      const keyIndex = NODE_OPERATORS[secondNodeOperatorId].vettedSigningKeysCount + 1
      assert.isTrue(keyIndex <= NODE_OPERATORS[secondNodeOperatorId].totalSigningKeysCount)
      const { vettedSigningKeysCount: vettedSigningKeysCountBefore } = await app.testing_getTotalSigningKeysStats()
      await app.removeSigningKey(secondNodeOperatorId, keyIndex, { from: voting })
      const { vettedSigningKeysCount: vettedSigningKeysCountAfter } = await app.testing_getTotalSigningKeysStats()
      assert.equals(vettedSigningKeysCountAfter, vettedSigningKeysCountBefore)
    })

    it('increases keysOpIndex & changes nonce', async () => {
      const keyIndex = NODE_OPERATORS[firstNodeOperatorId].depositedSigningKeysCount + 1
      const [keysOpIndexBefore, nonceBefore] = await Promise.all([app.getKeysOpIndex(), app.getNonce()])
      await app.removeSigningKey(firstNodeOperatorId, keyIndex, { from: voting })
      const [keysOpIndexAfter, nonceAfter] = await Promise.all([app.getKeysOpIndex(), app.getNonce()])
      assert.equals(keysOpIndexAfter, keysOpIndexBefore.toNumber() + 1)
      assert.notEquals(nonceAfter, nonceBefore)
    })

    it('emits KeysOpIndexSet & NonceChanged', async () => {
      const keyIndex = NODE_OPERATORS[firstNodeOperatorId].depositedSigningKeysCount + 1
      const keysOpIndexBefore = await app.getKeysOpIndex()
      const receipt = await app.removeSigningKey(firstNodeOperatorId, keyIndex, { from: voting })
      const nonceAfter = await app.getNonce()
      assert.emits(receipt, 'KeysOpIndexSet', { keysOpIndex: keysOpIndexBefore.toNumber() + 1 })
      assert.emits(receipt, 'NonceChanged', { nonce: nonceAfter })
    })

    it('correctly removes the last unused signing key', async () => {
      const keyIndex = NODE_OPERATORS[firstNodeOperatorId].totalSigningKeysCount - 1
      await app.removeSigningKey(firstNodeOperatorId, keyIndex, { from: voting })
      const { totalSigningKeys } = await app.getNodeOperator(firstNodeOperatorId, false)
      for (let i = 0; i < totalSigningKeys.toNumber(); ++i) {
        const { key, depositSignature } = await app.getSigningKey(firstNodeOperatorId, i)
        const [expectedPublicKey, expectedSignature] = firstNodeOperatorKeys.get(i)
        assert.equal(key, expectedPublicKey)
        assert.equal(depositSignature, expectedSignature)
      }
    })

    it('correctly removes unused signing key from the middle', async () => {
      const keyIndex = NODE_OPERATORS[secondNodeOperatorId].vettedSigningKeysCount - 1
      assert.notEqual(NODE_OPERATORS[secondNodeOperatorId].totalSigningKeysCount - 1, keyIndex)
      await app.removeSigningKey(secondNodeOperatorId, keyIndex, { from: voting })
      for (let i = 0; i < keyIndex; ++i) {
        const { key, depositSignature } = await app.getSigningKey(secondNodeOperatorId, i)
        const [expectedPublicKey, expectedSignature] = secondNodeOperatorKeys.get(i)
        assert.equal(key, expectedPublicKey)
        assert.equal(depositSignature, expectedSignature)
      }
      // at the removed key place now must be the previously last key
      const { key, depositSignature } = await app.getSigningKey(secondNodeOperatorId, keyIndex)
      const [expectedPublicKey, expectedSignature] = secondNodeOperatorKeys.get(secondNodeOperatorKeys.count - 1)
      assert.equal(key, expectedPublicKey)
      assert.equal(depositSignature, expectedSignature)
      const { totalSigningKeys } = await app.getNodeOperator(secondNodeOperatorId, false)
      for (let i = keyIndex + 1; i < totalSigningKeys.toNumber(); ++i) {
        const { key, depositSignature } = await app.getSigningKey(secondNodeOperatorId, i)
        const [expectedPublicKey, expectedSignature] = secondNodeOperatorKeys.get(i)
        assert.equal(key, expectedPublicKey)
        assert.equal(depositSignature, expectedSignature)
      }
    })

    it('can remove all unused keys of node operator', async () => {
      const unusedKeysCount =
        NODE_OPERATORS[firstNodeOperatorId].totalSigningKeysCount -
        NODE_OPERATORS[firstNodeOperatorId].depositedSigningKeysCount
      for (let i = 0; i < unusedKeysCount; ++i) {
        // always remove the first signing key
        await app.removeSigningKey(firstNodeOperatorId, NODE_OPERATORS[firstNodeOperatorId].depositedSigningKeysCount, {
          from: voting
        })
      }
      const { totalSigningKeys, stakingLimit, usedSigningKeys } = await app.getNodeOperator(firstNodeOperatorId, false)
      for (let i = 0; i < totalSigningKeys.toNumber(); ++i) {
        const { key, depositSignature } = await app.getSigningKey(firstNodeOperatorId, i)
        const [expectedPublicKey, expectedSignature] = firstNodeOperatorKeys.get(i)
        assert.equal(key, expectedPublicKey)
        assert.equal(depositSignature, expectedSignature)
      }
      assert.equals(stakingLimit, NODE_OPERATORS[firstNodeOperatorId].depositedSigningKeysCount)
      assert.equals(usedSigningKeys, NODE_OPERATORS[firstNodeOperatorId].depositedSigningKeysCount)
      assert.equals(totalSigningKeys, NODE_OPERATORS[firstNodeOperatorId].depositedSigningKeysCount)
    })

    it("doesn't modify keys of other node operators", async () => {
      const unusedKeysCount =
        NODE_OPERATORS[firstNodeOperatorId].totalSigningKeysCount -
        NODE_OPERATORS[firstNodeOperatorId].depositedSigningKeysCount
      // remove all unused signing keys of first node operator
      for (let i = 0; i < unusedKeysCount; ++i) {
        await app.removeSigningKey(firstNodeOperatorId, NODE_OPERATORS[firstNodeOperatorId].depositedSigningKeysCount, {
          from: voting
        })
      }

      for (let i = 0; i < secondNodeOperatorKeys.count; ++i) {
        const { key, depositSignature } = await app.getSigningKey(secondNodeOperatorId, i)
        const [expectedPublicKey, expectedSignature] = secondNodeOperatorKeys.get(i)
        assert.equal(key, expectedPublicKey)
        assert.equal(depositSignature, expectedSignature)
      }
    })

    it('after key removal new key adding works correctly', async () => {
      const keyIndex = NODE_OPERATORS[secondNodeOperatorId].vettedSigningKeysCount - 1
      assert.isTrue(keyIndex <= NODE_OPERATORS[secondNodeOperatorId].totalSigningKeysCount)
      await app.removeSigningKey(secondNodeOperatorId, keyIndex, { from: voting })
      const { totalSigningKeys } = await app.getNodeOperator(secondNodeOperatorId, false)
      const keysToAdd = new signingKeys.FakeValidatorKeys(1)
      await app.addSigningKeys(secondNodeOperatorId, keysToAdd.count, ...keysToAdd.slice(), { from: voting })
      const { key, depositSignature } = await app.getSigningKey(secondNodeOperatorId, totalSigningKeys.toNumber())
      assert.equal(key, keysToAdd.get(0)[0])
      assert.equal(depositSignature, keysToAdd.get(0)[1])
    })

    it('emits VettedSigningKeysCountChanged event with correct params if passed index is less then current vetted signing keys count', async () => {
      const keyIndex = NODE_OPERATORS[secondNodeOperatorId].vettedSigningKeysCount - 1
      assert.isTrue(keyIndex <= NODE_OPERATORS[secondNodeOperatorId].totalSigningKeysCount)
      const receipt = await app.removeSigningKey(secondNodeOperatorId, keyIndex, { from: voting })
      assert.emits(receipt, 'VettedSigningKeysCountChanged', {
        nodeOperatorId: secondNodeOperatorId,
        approvedValidatorsCount: keyIndex
      })
    })

    it("doesn't emit VettedSigningKeysCountChanged event if passed index is equal to the current vetted signing keys count", async () => {
      const keyIndex = NODE_OPERATORS[secondNodeOperatorId].vettedSigningKeysCount
      assert.isTrue(keyIndex <= NODE_OPERATORS[secondNodeOperatorId].totalSigningKeysCount)
      const receipt = await app.removeSigningKey(secondNodeOperatorId, keyIndex, { from: voting })
      assert.notEmits(receipt, 'VettedSigningKeysCountChanged', { nodeOperatorId: secondNodeOperatorId })
    })

    it("doesn't emit VettedSigningKeysCountChanged event if passed index is greater than current vetted signing keys count", async () => {
      const keyIndex = NODE_OPERATORS[secondNodeOperatorId].vettedSigningKeysCount + 1
      assert.isTrue(keyIndex <= NODE_OPERATORS[secondNodeOperatorId].totalSigningKeysCount)
      const receipt = await app.removeSigningKey(secondNodeOperatorId, keyIndex, { from: voting })
      assert.notEmits(receipt, 'VettedSigningKeysCountChanged', { nodeOperatorId: secondNodeOperatorId })
    })

    it('emits TotalSigningKeysCountChanged event with correct params', async () => {
      const keyIndex = NODE_OPERATORS[firstNodeOperatorId].totalSigningKeysCount - 1
      assert.isTrue(keyIndex <= NODE_OPERATORS[firstNodeOperatorId].totalSigningKeysCount)
      const receipt = await app.removeSigningKey(firstNodeOperatorId, keyIndex, { from: voting })
      assert.emits(
        receipt,
        'TotalSigningKeysCountChanged',
        {
          nodeOperatorId: firstNodeOperatorId,
          totalValidatorsCount: NODE_OPERATORS[firstNodeOperatorId].totalSigningKeysCount - 1
        },
        { abi: NodeOperatorsRegistry._json.abi }
      )
    })

    it('emits SigningKeyRemoved event with correct params', async () => {
      const keyIndex = NODE_OPERATORS[firstNodeOperatorId].depositedSigningKeysCount
      assert.isTrue(keyIndex <= NODE_OPERATORS[firstNodeOperatorId].totalSigningKeysCount)
      const receipt = await app.removeSigningKey(firstNodeOperatorId, keyIndex, { from: voting })
      assert.emits(
        receipt,
        'SigningKeyRemoved',
        {
          nodeOperatorId: firstNodeOperatorId,
          pubkey: firstNodeOperatorKeys.get(keyIndex)[0]
        },
        { abi: SigningKeys._json.abi }
      )
    })
  })

  describe('removeSigningKeys()', () => {
    const firstNodeOperatorId = 0
    const secondNodeOperatorId = 1
    const nonExistentNodeOperatorId = 3
    let firstNodeOperatorKeys, secondNodeOperatorKeys

    beforeEach(async () => {
      await nodeOperators
        .addNodeOperator(app, NODE_OPERATORS[0], { from: voting })
        .then((r) => (firstNodeOperatorKeys = r.validatorKeys))
      await nodeOperators
        .addNodeOperator(app, NODE_OPERATORS[1], { from: voting })
        .then((r) => (secondNodeOperatorKeys = r.validatorKeys))
    })

    it('reverts with APP_AUTH_FAILED error when called by sender without MANAGE_SIGNING_KEYS role', async () => {
      const hasPermission = await dao.hasPermission(nobody, app, 'STAKING_ROUTER_ROLE')
      assert.isFalse(hasPermission)
      const keyIndex = NODE_OPERATORS[firstNodeOperatorId].depositedSigningKeysCount
      const keysCount = NODE_OPERATORS[firstNodeOperatorId].totalSigningKeysCount - keyIndex
      await assert.reverts(app.removeSigningKeys(firstNodeOperatorId, keyIndex, keysCount, { from: nobody }))
    })

    it('returns earlier if keys count is 0', async () => {
      const keyIndex = NODE_OPERATORS[firstNodeOperatorId].depositedSigningKeysCount
      await app.removeSigningKeys(firstNodeOperatorId, keyIndex, 0, { from: voting })
      const { totalSigningKeys } = await app.getNodeOperator(firstNodeOperatorId, false)
      assert.equals(totalSigningKeys, NODE_OPERATORS[firstNodeOperatorId].totalSigningKeysCount)
    })

    it('reverts with "OUT_OF_RANGE" error when called on non existent validator', async () => {
      const keyIndex = 0
      const keysCount = 10
      await assert.reverts(
        app.removeSigningKeys(nonExistentNodeOperatorId, keyIndex, keysCount, { from: voting }),
        'OUT_OF_RANGE'
      )
    })

    it('reverts with OUT_OF_RANGE error when index greater than UINT64_MAX', async () => {
      const keyIndex = toBN('0x10000000000000000')
      const keysCount = 10
      await assert.reverts(
        app.removeSigningKeys(firstNodeOperatorId, keyIndex, keysCount, { from: voting }),
        'OUT_OF_RANGE'
      )
    })

    it('reverts with OUT_OF_RANGE error when keys count greater than UINT64_MAX', async () => {
      const keyIndex = NODE_OPERATORS[firstNodeOperatorId].depositedSigningKeysCount
      const keysCount = toBN('0x10000000000000000')
      await assert.reverts(
        app.removeSigningKeys(firstNodeOperatorId, keyIndex, keysCount, { from: voting }),
        'OUT_OF_RANGE'
      )
    })

    it('reverts with OUT_OF_RANGE error when index + keys count greater than UINT64_MAX', async () => {
      const keyIndex = toBN('0x8000000000000000')
      const keysCount = toBN('0x8000000000000000')
      await assert.reverts(
        app.removeSigningKeys(firstNodeOperatorId, keyIndex, keysCount, { from: voting }),
        'OUT_OF_RANGE'
      )
    })

    it('reverts with OUT_OF_RANGE error when fromIndex + keysCount is greater than total signing keys count', async () => {
      const keyIndex = NODE_OPERATORS[secondNodeOperatorId].depositedSigningKeysCount
      const keysCount = NODE_OPERATORS[secondNodeOperatorId].totalSigningKeysCount - keyIndex + 1
      assert(keyIndex + keysCount > NODE_OPERATORS[secondNodeOperatorId].totalSigningKeysCount)
      await assert.reverts(
        app.removeSigningKeys(secondNodeOperatorId, keyIndex, keysCount, { from: voting }),
        'OUT_OF_RANGE'
      )
    })

    it('reverts with OUT_OF_RANGE error when fromIndex is less than depositedSigningKeysCount', async () => {
      const keyIndex = NODE_OPERATORS[firstNodeOperatorId].depositedSigningKeysCount - 1
      assert(keyIndex >= 0)
      const keysCount = NODE_OPERATORS[firstNodeOperatorId].vettedSigningKeysCount - keyIndex
      assert(keysCount > 0)
      await assert.reverts(
        app.removeSigningKeys(firstNodeOperatorId, keyIndex, keysCount, { from: voting }),
        'OUT_OF_RANGE'
      )
    })

    it('decreases total signing keys counter for node operator correctly', async () => {
      const keyIndex = NODE_OPERATORS[secondNodeOperatorId].depositedSigningKeysCount
      const keysCount = NODE_OPERATORS[secondNodeOperatorId].totalSigningKeysCount - keyIndex
      assert(keysCount > 0)
      const { totalSigningKeys: totalSigningKeysBefore } = await app.getNodeOperator(secondNodeOperatorId, false)
      await app.removeSigningKeys(secondNodeOperatorId, keyIndex, keysCount, { from: voting })
      const { totalSigningKeys: totalSigningKeysAfter } = await app.getNodeOperator(secondNodeOperatorId, false)
      assert.equal(totalSigningKeysAfter.toNumber(), totalSigningKeysBefore.toNumber() - keysCount)
    })

    it('decreases global total signing keys counter correctly', async () => {
      const keyIndex = NODE_OPERATORS[secondNodeOperatorId].depositedSigningKeysCount + 1
      const keysCount = NODE_OPERATORS[secondNodeOperatorId].vettedSigningKeysCount - keyIndex
      assert(keysCount > 0)
      const { totalSigningKeysCount: totalSigningKeysCountBefore } = await app.testing_getTotalSigningKeysStats()
      await app.removeSigningKeys(secondNodeOperatorId, keyIndex, keysCount, { from: voting })
      const { totalSigningKeysCount: totalSigningKeysCountAfter } = await app.testing_getTotalSigningKeysStats()
      assert.equal(totalSigningKeysCountAfter.toNumber(), totalSigningKeysCountBefore.toNumber() - keysCount)
    })

    it("doesn't change vetted signing keys counter if fromIndex is greater than vetted keys counter", async () => {
      const keyIndex = NODE_OPERATORS[firstNodeOperatorId].vettedSigningKeysCount + 1
      const keysCount = NODE_OPERATORS[firstNodeOperatorId].totalSigningKeysCount - keyIndex
      assert(keysCount > 0)
      const { stakingLimit: stakingLimitBefore } = await app.getNodeOperator(firstNodeOperatorId, false)
      await app.removeSigningKeys(firstNodeOperatorId, keyIndex, keysCount, { from: voting })
      const { stakingLimit: stakingLimitAfter } = await app.getNodeOperator(firstNodeOperatorId, false)
      assert.equals(stakingLimitBefore, stakingLimitAfter)
    })

    it("doesn't change vetted signing keys counter if fromIndex is equal to vetted keys counter", async () => {
      const keyIndex = NODE_OPERATORS[firstNodeOperatorId].vettedSigningKeysCount
      const keysCount = 1
      const { stakingLimit: stakingLimitBefore } = await app.getNodeOperator(firstNodeOperatorId, false)
      await app.removeSigningKeys(firstNodeOperatorId, keyIndex, keysCount, { from: voting })
      const { stakingLimit: stakingLimitAfter } = await app.getNodeOperator(firstNodeOperatorId, false)
      assert.equals(stakingLimitBefore, stakingLimitAfter)
    })

    it('sets vetted signing keys counter equal to fromIndex if it is less than vetted keys counter', async () => {
      const keyIndex = NODE_OPERATORS[secondNodeOperatorId].vettedSigningKeysCount - 1
      const keysCount = NODE_OPERATORS[secondNodeOperatorId].totalSigningKeysCount - keyIndex
      assert(keysCount > 0)
      await app.removeSigningKeys(secondNodeOperatorId, keyIndex, keysCount, { from: voting })
      const { stakingLimit: stakingLimitAfter } = await app.getNodeOperator(secondNodeOperatorId, false)
      assert.equal(stakingLimitAfter.toNumber(), keyIndex)
    })

    it('correctly decreases global vetted signing keys count if fromIndex is less then vetted keys counter of node operator', async () => {
      const keyIndex = NODE_OPERATORS[secondNodeOperatorId].vettedSigningKeysCount - 1
      const keysCount = 2
      const { vettedSigningKeysCount: vettedSigningKeysCountBefore } = await app.testing_getTotalSigningKeysStats()
      await app.removeSigningKeys(secondNodeOperatorId, keyIndex, keysCount, { from: voting })
      const { vettedSigningKeysCount: vettedSigningKeysCountAfter } = await app.testing_getTotalSigningKeysStats()
      const vettedSigningKeysDecrement = NODE_OPERATORS[secondNodeOperatorId].vettedSigningKeysCount - keyIndex
      assert.equal(
        vettedSigningKeysCountAfter.toNumber(),
        vettedSigningKeysCountBefore.toNumber() - vettedSigningKeysDecrement
      )
    })

    it("doesn't modify global vetted signing keys count if fromIndex is equal to vettedSigningKeysCount", async () => {
      const keyIndex = NODE_OPERATORS[secondNodeOperatorId].vettedSigningKeysCount
      const keysCount = NODE_OPERATORS[secondNodeOperatorId].totalSigningKeysCount - keyIndex - 1
      const { vettedSigningKeysCount: vettedSigningKeysCountBefore } = await app.testing_getTotalSigningKeysStats()
      await app.removeSigningKeys(secondNodeOperatorId, keyIndex, keysCount, { from: voting })
      const { vettedSigningKeysCount: vettedSigningKeysCountAfter } = await app.testing_getTotalSigningKeysStats()
      assert.equals(vettedSigningKeysCountAfter, vettedSigningKeysCountBefore)
    })

    it("doesn't modify global vetted signing keys count if fromIndex is greater than vettedSigningKeysCount", async () => {
      const keyIndex = NODE_OPERATORS[secondNodeOperatorId].vettedSigningKeysCount + 1
      const keysCount = 1
      const { vettedSigningKeysCount: vettedSigningKeysCountBefore } = await app.testing_getTotalSigningKeysStats()
      await app.removeSigningKeys(secondNodeOperatorId, keyIndex, keysCount, { from: voting })
      const { vettedSigningKeysCount: vettedSigningKeysCountAfter } = await app.testing_getTotalSigningKeysStats()
      assert.equals(vettedSigningKeysCountAfter, vettedSigningKeysCountBefore)
    })

    it('increases keysOpIndex & changes nonce', async () => {
      const keyIndex = NODE_OPERATORS[firstNodeOperatorId].depositedSigningKeysCount + 1
      const keysCount = NODE_OPERATORS[firstNodeOperatorId].totalSigningKeysCount - keyIndex
      assert(keysCount > 0)
      const [keysOpIndexBefore, nonceBefore] = await Promise.all([app.getKeysOpIndex(), app.getNonce()])
      await app.removeSigningKeys(firstNodeOperatorId, keyIndex, keysCount, { from: voting })
      const [keysOpIndexAfter, nonceAfter] = await Promise.all([app.getKeysOpIndex(), app.getNonce()])
      assert.equals(keysOpIndexAfter, keysOpIndexBefore.toNumber() + 1)
      assert.notEquals(nonceAfter, nonceBefore)
    })

    it('emits KeysOpIndexSet & NonceChanged', async () => {
      const keyIndex = NODE_OPERATORS[firstNodeOperatorId].depositedSigningKeysCount + 1
      const keysCount = NODE_OPERATORS[firstNodeOperatorId].totalSigningKeysCount - keyIndex
      assert(keysCount > 0)
      const keysOpIndexBefore = await app.getKeysOpIndex()
      const receipt = await app.removeSigningKeys(firstNodeOperatorId, keyIndex, keysCount, { from: voting })
      const nonceAfter = await app.getNonce()
      assert.emits(receipt, 'KeysOpIndexSet', { keysOpIndex: keysOpIndexBefore.toNumber() + 1 })
      assert.emits(receipt, 'NonceChanged', { nonce: nonceAfter })
    })

    it('correctly removes all unvetted keys', async () => {
      const keyIndex = NODE_OPERATORS[secondNodeOperatorId].vettedSigningKeysCount
      const keysCount = NODE_OPERATORS[secondNodeOperatorId].totalSigningKeysCount - keyIndex
      assert(keysCount > 0)
      await app.removeSigningKeys(secondNodeOperatorId, keyIndex, keysCount, { from: voting })
      const { totalSigningKeys, stakingLimit } = await app.getNodeOperator(secondNodeOperatorId, false)
      assert.equals(totalSigningKeys, NODE_OPERATORS[secondNodeOperatorId].vettedSigningKeysCount)
      assert.equals(stakingLimit, NODE_OPERATORS[secondNodeOperatorId].vettedSigningKeysCount)
      for (let i = 0; i < totalSigningKeys.toNumber(); ++i) {
        const { key, depositSignature } = await app.getSigningKey(secondNodeOperatorId, i)
        const [expectedPublicKey, expectedSignature] = secondNodeOperatorKeys.get(i)
        assert.equal(key, expectedPublicKey)
        assert.equal(depositSignature, expectedSignature)
      }
    })

    it('correctly removes all vetted keys', async () => {
      const keyIndex = NODE_OPERATORS[secondNodeOperatorId].depositedSigningKeysCount
      const keysCount = NODE_OPERATORS[secondNodeOperatorId].vettedSigningKeysCount - keyIndex
      assert(keysCount > 0)
      await app.removeSigningKeys(secondNodeOperatorId, keyIndex, keysCount, { from: voting })
      const { totalSigningKeys, stakingLimit } = await app.getNodeOperator(secondNodeOperatorId, false)
      assert.equals(
        totalSigningKeys,
        NODE_OPERATORS[secondNodeOperatorId].totalSigningKeysCount -
          (NODE_OPERATORS[secondNodeOperatorId].vettedSigningKeysCount -
            NODE_OPERATORS[secondNodeOperatorId].depositedSigningKeysCount)
      )
      assert.equals(stakingLimit, NODE_OPERATORS[secondNodeOperatorId].depositedSigningKeysCount)

      // the deposited keys must stay untouched
      for (let i = 0; i < keyIndex; ++i) {
        const { key, depositSignature } = await app.getSigningKey(secondNodeOperatorId, i)
        const [expectedPublicKey, expectedSignature] = secondNodeOperatorKeys.get(i)
        assert.equal(key, expectedPublicKey)
        assert.equal(depositSignature, expectedSignature)
      }
      // all removed keys replaced by the keys from the end of the batch
      for (let i = 0; i < keysCount; ++i) {
        const { key, depositSignature } = await app.getSigningKey(secondNodeOperatorId, keyIndex + i)
        const [expectedPublicKey, expectedSignature] = secondNodeOperatorKeys.get(
          secondNodeOperatorKeys.count - keysCount + i
        )
        assert.equal(key, expectedPublicKey)
        assert.equal(depositSignature, expectedSignature)
      }
      // the rest of the batch stays same
      for (let i = keyIndex + keysCount; i < totalSigningKeys.toNumber(); ++i) {
        const { key, depositSignature } = await app.getSigningKey(secondNodeOperatorId, i)
        const [expectedPublicKey, expectedSignature] = secondNodeOperatorKeys.get(i)
        assert.equal(key, expectedPublicKey)
        assert.equal(depositSignature, expectedSignature)
      }
    })

    it('correctly removes unused signing key from the middle', async () => {
      const keyIndex = NODE_OPERATORS[firstNodeOperatorId].depositedSigningKeysCount + 1
      const keysCount = NODE_OPERATORS[firstNodeOperatorId].totalSigningKeysCount - keyIndex - 1
      assert(keysCount > 0)
      await app.removeSigningKeys(firstNodeOperatorId, keyIndex, keysCount, { from: voting })
      const { totalSigningKeys, stakingLimit } = await app.getNodeOperator(firstNodeOperatorId, false)
      assert.equals(totalSigningKeys, NODE_OPERATORS[firstNodeOperatorId].totalSigningKeysCount - keysCount)
      assert.equals(stakingLimit, keyIndex)
      for (let i = 0; i < keyIndex; ++i) {
        const { key, depositSignature } = await app.getSigningKey(firstNodeOperatorId, i)
        const [expectedPublicKey, expectedSignature] = firstNodeOperatorKeys.get(i)
        assert.equal(key, expectedPublicKey)
        assert.equal(depositSignature, expectedSignature)
      }

      // the deposited keys must stay untouched
      for (let i = 0; i < keyIndex; ++i) {
        const { key, depositSignature } = await app.getSigningKey(firstNodeOperatorId, i)
        const [expectedPublicKey, expectedSignature] = firstNodeOperatorKeys.get(i)
        assert.equal(key, expectedPublicKey)
        assert.equal(depositSignature, expectedSignature)
      }
      // in this case we removed all keys except the last one
      assert.equals(totalSigningKeys, keyIndex + 1)
      // the last key stays on the same place
      const [expectedPublicKey, expectedSignature] = firstNodeOperatorKeys.get(firstNodeOperatorKeys.count - 1)
      const { key, depositSignature } = await app.getSigningKey(firstNodeOperatorId, keyIndex)
      assert.equal(key, expectedPublicKey)
      assert.equal(depositSignature, expectedSignature)
    })

    it('can remove all unused keys of node operator', async () => {
      const keyIndex = NODE_OPERATORS[firstNodeOperatorId].depositedSigningKeysCount
      const unusedKeysCount =
        NODE_OPERATORS[firstNodeOperatorId].totalSigningKeysCount -
        NODE_OPERATORS[firstNodeOperatorId].depositedSigningKeysCount
      assert(unusedKeysCount > 0)
      await app.removeSigningKeys(firstNodeOperatorId, keyIndex, unusedKeysCount, { from: voting })
      const { totalSigningKeys, stakingLimit, usedSigningKeys } = await app.getNodeOperator(firstNodeOperatorId, false)
      for (let i = 0; i < totalSigningKeys.toNumber(); ++i) {
        const { key, depositSignature } = await app.getSigningKey(firstNodeOperatorId, i)
        const [expectedPublicKey, expectedSignature] = firstNodeOperatorKeys.get(i)
        assert.equal(key, expectedPublicKey)
        assert.equal(depositSignature, expectedSignature)
      }
      assert.equals(stakingLimit, NODE_OPERATORS[firstNodeOperatorId].depositedSigningKeysCount)
      assert.equals(usedSigningKeys, NODE_OPERATORS[firstNodeOperatorId].depositedSigningKeysCount)
      assert.equals(totalSigningKeys, NODE_OPERATORS[firstNodeOperatorId].depositedSigningKeysCount)
    })

    it("doesn't modify keys of other node operators", async () => {
      const keyIndex = NODE_OPERATORS[firstNodeOperatorId].depositedSigningKeysCount
      const unusedKeysCount =
        NODE_OPERATORS[firstNodeOperatorId].totalSigningKeysCount -
        NODE_OPERATORS[firstNodeOperatorId].depositedSigningKeysCount
      assert(unusedKeysCount > 0)
      await app.removeSigningKeys(firstNodeOperatorId, keyIndex, unusedKeysCount, { from: voting })

      for (let i = 0; i < secondNodeOperatorKeys.count; ++i) {
        const { key, depositSignature } = await app.getSigningKey(secondNodeOperatorId, i)
        const [expectedPublicKey, expectedSignature] = secondNodeOperatorKeys.get(i)
        assert.equal(key, expectedPublicKey)
        assert.equal(depositSignature, expectedSignature)
      }
    })

    it('after keys removal new key adding works correctly', async () => {
      const keyIndex = NODE_OPERATORS[secondNodeOperatorId].vettedSigningKeysCount - 1
      const keysCount = 2
      await app.removeSigningKeys(secondNodeOperatorId, keyIndex, keysCount, { from: voting })
      const { totalSigningKeys } = await app.getNodeOperator(secondNodeOperatorId, false)
      const keysToAdd = new signingKeys.FakeValidatorKeys(1)
      await app.addSigningKeys(secondNodeOperatorId, keysToAdd.count, ...keysToAdd.slice(), { from: voting })
      const { key, depositSignature } = await app.getSigningKey(secondNodeOperatorId, totalSigningKeys.toNumber())
      assert.equal(key, keysToAdd.get(0)[0])
      assert.equal(depositSignature, keysToAdd.get(0)[1])
    })

    it('emits VettedSigningKeysCountChanged event with correct params if fromIndex is less then current vetted signing keys count', async () => {
      const keyIndex = NODE_OPERATORS[secondNodeOperatorId].vettedSigningKeysCount - 1
      const keysCount = NODE_OPERATORS[secondNodeOperatorId].totalSigningKeysCount - keyIndex
      assert(keysCount > 0)
      const receipt = await app.removeSigningKeys(secondNodeOperatorId, keyIndex, keysCount, { from: voting })
      assert.emits(receipt, 'VettedSigningKeysCountChanged', {
        nodeOperatorId: secondNodeOperatorId,
        approvedValidatorsCount: keyIndex
      })
    })

    it("doesn't emit VettedSigningKeysCountChanged event if fromIndex is equal to the current vetted signing keys count", async () => {
      const keyIndex = NODE_OPERATORS[secondNodeOperatorId].vettedSigningKeysCount
      const keysCount = 3
      assert.isTrue(keyIndex <= NODE_OPERATORS[secondNodeOperatorId].totalSigningKeysCount)
      const receipt = await app.removeSigningKeys(secondNodeOperatorId, keyIndex, keysCount, { from: voting })
      assert.notEmits(receipt, 'VettedSigningKeysCountChanged', { nodeOperatorId: secondNodeOperatorId })
    })

    it("doesn't emit VettedSigningKeysCountChanged event if passed index is greater than current vetted signing keys count", async () => {
      const keyIndex = NODE_OPERATORS[secondNodeOperatorId].vettedSigningKeysCount + 1
      const keysCount = NODE_OPERATORS[secondNodeOperatorId].totalSigningKeysCount - keyIndex
      assert(keysCount > 0)
      const receipt = await app.removeSigningKeys(secondNodeOperatorId, keyIndex, keysCount, { from: voting })
      assert.notEmits(receipt, 'VettedSigningKeysCountChanged', { nodeOperatorId: secondNodeOperatorId })
    })

    it('emits TotalSigningKeysCountChanged event with correct params', async () => {
      const keyIndex = NODE_OPERATORS[firstNodeOperatorId].depositedSigningKeysCount
      const keysCount = NODE_OPERATORS[firstNodeOperatorId].totalSigningKeysCount - keyIndex
      assert(keysCount > 0)
      const receipt = await app.removeSigningKeys(firstNodeOperatorId, keyIndex, keysCount, { from: voting })
      assert.emits(receipt, 'TotalSigningKeysCountChanged', {
        nodeOperatorId: firstNodeOperatorId,
        totalValidatorsCount: NODE_OPERATORS[firstNodeOperatorId].depositedSigningKeysCount
      })
    })

    it('emits SigningKeyRemoved event with correct params for every removed key', async () => {
      const keyIndex = NODE_OPERATORS[firstNodeOperatorId].vettedSigningKeysCount
      const keysCount = NODE_OPERATORS[firstNodeOperatorId].totalSigningKeysCount - keyIndex
      assert(keysCount > 0)
      const receipt = await app.removeSigningKeys(firstNodeOperatorId, keyIndex, keysCount, { from: voting })
      for (let i = keyIndex; i < keyIndex + keysCount; ++i) {
        assert.emits(
          receipt,
          'SigningKeyRemoved',
          {
            nodeOperatorId: firstNodeOperatorId,
            pubkey: firstNodeOperatorKeys.get(i)[0]
          },
          { abi: SigningKeys._json.abi }
        )
      }
    })
  })

  describe('removeSigningKeyOperatorBH()', () => {
    const firstNodeOperatorId = 0
    const rewardAddress = user1

    beforeEach(async () => {
      await nodeOperators.addNodeOperator(app, { ...NODE_OPERATORS[0], rewardAddress }, { from: voting })
    })

    it('reverts with OUT_OF_RANGE error when index greater than UINT64_MAX', async () => {
      const keyIndex = toBN('0x10000000000000000')
      await assert.reverts(
        app.removeSigningKeyOperatorBH(firstNodeOperatorId, keyIndex, { from: voting }),
        'OUT_OF_RANGE'
      )
    })

    it('reverts with APP_AUTH_FAILED error when called not by reward address', async () => {
      const keyIndex = NODE_OPERATORS[firstNodeOperatorId].depositedSigningKeysCount
      assert(nobody !== rewardAddress)
      await assert.reverts(
        app.removeSigningKeyOperatorBH(firstNodeOperatorId, keyIndex, { from: nobody }),
        'APP_AUTH_FAILED'
      )
    })

    it('reward address can remove signing keys', async () => {
      const keyIndex = NODE_OPERATORS[firstNodeOperatorId].depositedSigningKeysCount
      await app.removeSigningKeyOperatorBH(firstNodeOperatorId, keyIndex, { from: rewardAddress })
      const { totalSigningKeys } = await app.getNodeOperator(firstNodeOperatorId, false)
      assert.equals(totalSigningKeys, NODE_OPERATORS[firstNodeOperatorId].totalSigningKeysCount - 1)
    })
  })

  describe('removeSigningKeysOperatorBH()', () => {
    const firstNodeOperatorId = 0
    const rewardAddress = user1

    beforeEach(async () => {
      await nodeOperators.addNodeOperator(app, { ...NODE_OPERATORS[0], rewardAddress }, { from: voting })
    })

    it('reverts with OUT_OF_RANGE error when index greater than UINT64_MAX', async () => {
      const keyIndex = toBN('0x10000000000000000')
      const keysCount = 1
      await assert.reverts(
        app.removeSigningKeysOperatorBH(firstNodeOperatorId, keyIndex, keysCount, { from: voting }),
        'OUT_OF_RANGE'
      )
    })

    it('reverts with OUT_OF_RANGE error when keys count greater than UINT64_MAX', async () => {
      const keyIndex = NODE_OPERATORS[firstNodeOperatorId].vettedSigningKeysCount
      const keysCount = toBN('0x10000000000000000')
      await assert.reverts(
        app.removeSigningKeysOperatorBH(firstNodeOperatorId, keyIndex, keysCount, { from: voting }),
        'OUT_OF_RANGE'
      )
    })

    it('reverts with OUT_OF_RANGE error when index + keys count greater than UINT64_MAX', async () => {
      const keyIndex = toBN('0x8000000000000000')
      const keysCount = toBN('0x8000000000000000')
      await assert.reverts(
        app.removeSigningKeysOperatorBH(firstNodeOperatorId, keyIndex, keysCount, { from: voting }),
        'OUT_OF_RANGE'
      )
    })

    it('reverts with APP_AUTH_FAILED error when called not by reward address', async () => {
      const keyIndex = NODE_OPERATORS[firstNodeOperatorId].depositedSigningKeysCount
      const keysCount = 1
      assert(nobody !== rewardAddress)
      await assert.reverts(
        app.removeSigningKeysOperatorBH(firstNodeOperatorId, keyIndex, keysCount, { from: nobody }),
        'APP_AUTH_FAILED'
      )
    })

    it('reward address can remove signing keys', async () => {
      const keyIndex = NODE_OPERATORS[firstNodeOperatorId].depositedSigningKeysCount
      const keysCount = NODE_OPERATORS[firstNodeOperatorId].totalSigningKeysCount - keyIndex
      await app.removeSigningKeysOperatorBH(firstNodeOperatorId, keyIndex, keysCount, { from: rewardAddress })
      const { totalSigningKeys } = await app.getNodeOperator(firstNodeOperatorId, false)
      assert.equals(totalSigningKeys, NODE_OPERATORS[firstNodeOperatorId].totalSigningKeysCount - keysCount)
    })
  })

  describe('distributing rewards', () => {
    beforeEach(async () => {
      await app.testing_addNodeOperator('0', user1, 3, 3, 3, 0)
      await app.testing_addNodeOperator('1', user2, 7, 7, 7, 0)
      await app.testing_addNodeOperator('2', user3, 0, 0, 0, 0)
    })

    it('reverts if no STAKING_ROUTER_ROLE', async () => {
      await assert.reverts(app.onAllValidatorCountersUpdated({ from: user3 }), 'APP_AUTH_FAILED')
    })

    it("doesn't distribute rewards if no shares to distribute", async () => {
      const sharesCount = await steth.sharesOf(app.address)
      assert.equals(sharesCount, 0)
      const recipientsSharesBefore = await Promise.all([
        steth.sharesOf(user1),
        steth.sharesOf(user2),
        steth.sharesOf(user3)
      ])
      // calls distributeRewards() inside
      await app.onAllValidatorCountersUpdated({ from: voting })
      const recipientsSharesAfter = await Promise.all([
        steth.sharesOf(user1),
        steth.sharesOf(user2),
        steth.sharesOf(user3)
      ])
      assert.equal(recipientsSharesBefore.length, recipientsSharesAfter.length)
      for (let i = 0; i < recipientsSharesBefore.length; ++i) {
        assert.equals(recipientsSharesBefore[i], recipientsSharesAfter[i])
      }
    })

    it('must distribute rewards to operators', async () => {
      await steth.setTotalPooledEther(ETH(100))
      await steth.mintShares(app.address, ETH(10))

      // calls distributeRewards() inside
      await app.onAllValidatorCountersUpdated({ from: voting })

      assert.equals(await steth.sharesOf(user1), ETH(3))
      assert.equals(await steth.sharesOf(user2), ETH(7))
      assert.equals(await steth.sharesOf(user3), 0)
    })

    it('emits RewardsDistributed with correct params on reward distribution', async () => {
      await steth.setTotalPooledEther(ETH(100))
      await steth.mintShares(app.address, ETH(10))

      // calls distributeRewards() inside
      receipt = await app.onAllValidatorCountersUpdated({ from: voting })

      assert.emits(receipt, 'RewardsDistributed', { rewardAddress: user1, sharesAmount: ETH(3) })
      assert.emits(receipt, 'RewardsDistributed', { rewardAddress: user2, sharesAmount: ETH(7) })
      assert.notEmits(receipt, 'RewardsDistributed', { rewardAddress: user3, sharesAmount: 0 })
    })
  })

  describe('getTotalSigningKeyCount(nodeOperatorId)', () => {
    const firstNodeOperatorId = 0
    const secondNodeOperatorId = 1
    const notExistedNodeOperatorId = 3

    beforeEach(async () => {
      await nodeOperators.addNodeOperator(app, NODE_OPERATORS[0], { from: voting })
      await app.addNodeOperator('empty', ADDRESS_2, { from: voting })
    })

    it('reverts with OUT_OF_RANGE error when called with not existed node operator id', async () => {
      await assert.reverts(app.getTotalSigningKeyCount(notExistedNodeOperatorId), 'OUT_OF_RANGE')
    })

    it('returns correct result for empty node operator', async () => {
      assert.equals(await app.getTotalSigningKeyCount(secondNodeOperatorId), 0)
    })

    it('returns correct result for node operator with added keys', async () => {
      assert.equals(
        await app.getTotalSigningKeyCount(firstNodeOperatorId),
        NODE_OPERATORS[firstNodeOperatorId].totalSigningKeysCount
      )
    })
  })

  describe('getUnusedSigningKeyCount(nodeOperatorId)', () => {
    const firstNodeOperatorId = 0
    const secondNodeOperatorId = 1
    const notExistedNodeOperatorId = 3

    beforeEach(async () => {
      await nodeOperators.addNodeOperator(app, NODE_OPERATORS[0], { from: voting })
      await app.addNodeOperator('empty', ADDRESS_2, { from: voting })
    })

    it('reverts with OUT_OF_RANGE error when called with not existed node operator id', async () => {
      await assert.reverts(app.getUnusedSigningKeyCount(notExistedNodeOperatorId), 'OUT_OF_RANGE')
    })

    it('returns correct result for empty node operator', async () => {
      assert.equals(await app.getUnusedSigningKeyCount(secondNodeOperatorId), 0)
    })

    it('returns correct result for node operator with added keys', async () => {
      assert.equals(
        await app.getUnusedSigningKeyCount(firstNodeOperatorId),
        NODE_OPERATORS[firstNodeOperatorId].totalSigningKeysCount -
          NODE_OPERATORS[firstNodeOperatorId].depositedSigningKeysCount
      )
    })
  })

  describe('getSigningKey()', () => {
    const firstNodeOperatorId = 0
    const secondNodeOperatorId = 1
    const notExistedNodeOperatorId = 3
    let firstNodeOperatorKeys, secondNodeOperatorKeys

    beforeEach(async () => {
      await nodeOperators
        .addNodeOperator(app, NODE_OPERATORS[0], { from: voting })
        .then((r) => (firstNodeOperatorKeys = r.validatorKeys))
      await nodeOperators
        .addNodeOperator(app, NODE_OPERATORS[1], { from: voting })
        .then((r) => (secondNodeOperatorKeys = r.validatorKeys))
    })

    it('reverts with OUT_OF_RANGE error when called with not existed node operator id', async () => {
      await assert.reverts(app.getSigningKey(notExistedNodeOperatorId, 0), 'OUT_OF_RANGE')
    })

    it('reverts with OUT_OF_RANGE error when keyIndex is greater then total signing keys count', async () => {
      const notExistedKeyIndex = NODE_OPERATORS[firstNodeOperatorId].totalSigningKeysCount
      await assert.reverts(app.getSigningKey(firstNodeOperatorId, notExistedKeyIndex), 'OUT_OF_RANGE')
    })

    it('returns correct key and signature', async () => {
      const nodeOperatorsData = [
        [firstNodeOperatorId, firstNodeOperatorKeys],
        [secondNodeOperatorId, secondNodeOperatorKeys]
      ]
      for (const [nodeOperatorId, nodeOperatorKeys] of nodeOperatorsData) {
        for (let i = 0; i < nodeOperatorKeys.count; ++i) {
          const { key, depositSignature } = await app.getSigningKey(nodeOperatorId, i)
          const [expectedPublicKey, expectedSignature] = await nodeOperatorKeys.get(i)
          assert.equal(key, expectedPublicKey)
          assert.equal(depositSignature, expectedSignature)
        }
      }
    })

    it('used is true for all deposited signing keys', async () => {
      for (let i = 0; i < NODE_OPERATORS[firstNodeOperatorId].depositedSigningKeysCount; ++i) {
        const { used } = await app.getSigningKey(firstNodeOperatorId, i)
        assert.isTrue(used)
      }
      for (let i = 0; i < NODE_OPERATORS[secondNodeOperatorId].depositedSigningKeysCount; ++i) {
        const { used } = await app.getSigningKey(secondNodeOperatorId, i)
        assert.isTrue(used)
      }
    })

    it('used is false for all unused signing keys', async () => {
      for (
        let i = NODE_OPERATORS[firstNodeOperatorId].depositedSigningKeysCount;
        i < NODE_OPERATORS[firstNodeOperatorId].totalSigningKeysCount;
        ++i
      ) {
        const { used } = await app.getSigningKey(firstNodeOperatorId, i)
        assert.isFalse(used)
      }
      for (
        let i = NODE_OPERATORS[secondNodeOperatorId].depositedSigningKeysCount;
        i < NODE_OPERATORS[secondNodeOperatorId].totalSigningKeysCount;
        ++i
      ) {
        const { used } = await app.getSigningKey(secondNodeOperatorId, i)
        assert.isFalse(used)
      }
    })
  })

  describe('getSigningKeys()', () => {
    it('reverts with OUT_OF_RANGE when called with not existed node operator id', async () => {
      await assert.reverts(app.getSigningKeys(0, 0, 10), 'OUT_OF_RANGE')
    })

    it('reverts with OUT_OF_RANGE', async () => {
      await app.addNodeOperator('0', user1, { from: voting })

      await assert.reverts(app.getSigningKeys(0, 0, 10), 'OUT_OF_RANGE')
    })

    it('returns specified signing keys', async () => {
      await app.addNodeOperator('0', user1, { from: voting })

      const keys = [pad('0xaa0101', 48), pad('0xaa0202', 48), pad('0xaa0303', 48)]
      const sigs = [pad('0xa1', 96), pad('0xa2', 96), pad('0xa3', 96)]

      await app.addSigningKeys(0, 3, hexConcat(...keys), hexConcat(...sigs), { from: voting })

      const { pubkeys, signatures, used } = await app.getSigningKeys(0, 1, 2)

      assert.equal(pubkeys, keys[1] + keys[2].slice(2))
      assert.equal(signatures, sigs[1] + sigs[2].slice(2))
      assert.sameMembers(used, [false, false])
    })
  })

  describe('handleRewardsMinted()', () => {
    it('reverts with no STAKING_ROUTER_ROLE', async () => {
      const hasPermission = await dao.hasPermission(user1, app, 'STAKING_ROUTER_ROLE')
      assert.isFalse(hasPermission)
      await assert.reverts(app.handleRewardsMinted(123, { from: user1 }))
    })
    it('no reverts with STAKING_ROUTER_ROLE', async () => {
      const hasPermission = await dao.hasPermission(voting, app, 'STAKING_ROUTER_ROLE')
      assert.isTrue(hasPermission)
      await app.handleRewardsMinted(123, { from: voting })
    })
  })
})
