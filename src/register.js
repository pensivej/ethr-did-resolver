import { registerMethod } from 'did-resolver'
import HttpProvider from 'ethjs-provider-http'
import Eth from 'ethjs-query'
import abi from 'ethjs-abi'
import BN from 'bn.js'
import EthContract from 'ethjs-contract'
import DidRegistryContract from '../contracts/ethr-did-registry.json'
import { Buffer } from 'buffer'
export const REGISTRY = '0xdca7ef03e98e0dc2b855be647c39abe984fcf21b'

function bytes32toString (bytes32) {
  return Buffer.from(bytes32.slice(2), 'hex').toString('utf8').replace(/\0+$/, '')
}
const Secp256k1SignatureAuthentication2018 = 'Secp256k1SignatureAuthentication2018'.slice(0, 32)
const Secp256k1VerificationKey2018 = 'Secp256k1VerificationKey2018'.slice(0, 32)

export function wrapDidDocument (did, owner, history) {
  const now = new BN(Math.floor(new Date().getTime() / 1000))
  // const expired = {}
  const publicKey = [{
    id: `${did}#owner`,
    type: 'Secp256k1VerificationKey2018',
    owner: did,
    ethereumAddress: owner
  }]

  const authentication = [{
    type: 'Secp256k1SignatureAuthentication2018',
    publicKey: `${did}#owner`
  }]

  let delegateCount = 0
  const auth = {}
  const pks = {}
  const services = {}
  for (let event of history) {
    let validTo = event.validTo
    console.log(`validTo: ${validTo && validTo.toString(10)} and now: ${now.toString(10)}`)
    let delegateType = event.delegateType || event.name
    if (delegateType) {
      console.log(`orig delegateType ${delegateType}`)
      delegateType = bytes32toString(delegateType)
      console.log(`new delegateType ${delegateType}`)
    }
    console.log(Object.assign(event, {delegateType}))
    const key = `${event._eventName}-${delegateType}-${event.delegate || event.value}`
    if (validTo && validTo.gte(now)) {
      if (event._eventName === 'DIDDelegateChanged') {
        delegateCount++
        switch (delegateType) {
          case Secp256k1SignatureAuthentication2018:
            auth[key] = {
              type: 'Secp256k1SignatureAuthentication2018',
              publicKey: `${did}#delegate-${delegateCount}`
            }
          case Secp256k1VerificationKey2018:
            pks[key] = {
              id: `${did}#delegate-${delegateCount}`,
              type: 'Secp256k1VerificationKey2018',
              owner: did,
              ethereumAddress: event.delegate
            }
            break
        }
      } else if (event._eventName === 'DIDAttributeChanged') {
        const match = delegateType.match(/^did\/(publicKey|authentication|service)\/(\w+)(\/(\w+))?$/)
        if (match) {
          const section = match[1]
          const type = match[2]
          const encoding = match[4]
          switch (section) {
            case 'publicKey':
              delegateCount++
              const pk = {
                id: `${did}#delegate-${delegateCount}`,
                type,
                owner: did
              }
              switch (encoding) {
                case null:
                case undefined:
                case 'publicKeyHex':
                  pk.publicKeyHex = event.value.slice(2)
                  break
                case 'publicKeyBase64':
                  pk.publicKeyBase64 = Buffer.from(event.value.slice(2), 'hex').toString('base64')
                  break
                case 'publicKeyBase58':
                  pk.publicKeyBase58 = Buffer.from(event.value.slice(2), 'hex').toString('base58')
                  break
                default:
                  pk.value = event.value
              }
              pks[key] = pk
              break
            case 'service':
              services[key] = {type, serviceEndpoint: Buffer.from(event.value.slice(2), 'hex').toString()}
              break
          }
        }
      }
    } else {
      if (delegateCount > 0 && (event._eventName === 'DIDDelegateChanged' || (event._eventName === 'DIDAttributeChanged' && delegateType.match(/^did\/publicKey\//))) && validTo.lt(now)) delegateCount--
      delete auth[key]
      delete pks[key]
      delete services[key]
    }
  }

  const doc = {
    '@context': 'https://w3id.org/did/v1',
    id: did,
    publicKey: publicKey.concat(Object.values(pks)),
    authentication: authentication.concat(Object.values(auth))
  }
  if (Object.values(services).length > 0) {
    doc.service = Object.values(services)
  }

  return doc
}

function configureProvider (conf = {}) {
  if (conf.provider) {
    return conf.provider
  } else if (conf.web3) {
    return conf.web3.currentProvider
  } else {
    return new HttpProvider(conf.rpcUrl || 'https://mainnet.infura.io/ethr-did')
  }
}

function register (conf = {}) {
  const provider = configureProvider(conf)
  const eth = new Eth(provider)
  const registryAddress = conf.registry || REGISTRY
  const DidReg = new EthContract(eth)(DidRegistryContract)
  const didReg = DidReg.at(registryAddress)
  const logDecoder = abi.logDecoder(DidRegistryContract, false)

  const lastChanged = async (identity) => {
    const result = await didReg.changed(identity)
    if (result) {
      return result['0']
    }
  }
  async function changeLog (identity) {
    const history = []
    let previousChange = await lastChanged(identity)
    while (previousChange) {
      const logs = await eth.getLogs({address: registryAddress, topics: [null, `0x000000000000000000000000${identity.slice(2)}`], fromBlock: previousChange, toBlock: previousChange})
      const events = logDecoder(logs)
      previousChange = undefined
      for (let event of events) {
        history.unshift(event)
        previousChange = event.previousChange
      }
    }
    return history
  }
  async function resolve (did, parsed) {
    if (!parsed.id.match(/^0x[0-9a-fA-F]{40}$/)) throw new Error(`Not a valid ethr DID: ${did}`)
    const owner = await didReg.identityOwner(parsed.id)
    const history = await changeLog(parsed.id)
    return wrapDidDocument(did, owner['0'], history)
  }
  registerMethod('ethr', resolve)
}

module.exports = register
