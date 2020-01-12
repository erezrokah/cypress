const _ = require('lodash')
const CRI = require('chrome-remote-interface')
const { connect } = require('@packages/network')
const errors = require('../errors')
const Promise = require('bluebird')
const la = require('lazy-ass')
const is = require('check-more-types')
const debug = require('debug')('cypress:server:protocol')

function _getDelayMsForRetry (i) {
  if (i < 10) {
    return 100
  }

  if (i < 18) {
    return 500
  }

  if (i < 33) { // after 5 seconds, begin logging and retrying
    errors.warning('CDP_RETRYING_CONNECTION', i)

    return 1000
  }
}

function _connectAsync (opts) {
  return Promise.fromCallback((cb) => {
    connect.createRetryingSocket({
      getDelayMsForRetry: _getDelayMsForRetry,
      ...opts,
    }, cb)
  })
  .then((sock) => {
    // can be closed, just needed to test the connection
    sock.end()
  })
  .catch((err) => {
    errors.throw('CDP_COULD_NOT_CONNECT', opts.port, err)
  })
}

/**
 * Waits for the port to respond with connection to Chrome Remote Interface
 * @param {number} port Port number to connect to
 */
const getWsTargetFor = (port) => {
  debug('Getting WS connection to CRI on port %d', port)
  la(is.port(port), 'expected port number', port)

  // force ipv4
  // https://github.com/cypress-io/cypress/issues/5912
  const connectOpts = {
    host: '127.0.0.1',
    port,
  }

  return _connectAsync(connectOpts)
  .tapCatch((err) => {
    debug('failed to connect to CDP %o', { connectOpts, err })
  })
  .then(async () => {
    const newTabTargetFields = {
      type: 'page',
      url: 'about:blank',
    }

    const getTarget = () => {
      return CRI.List(connectOpts).then((targets) => {
        debug('CRI.List on port %d', port)
        const target = _.find(targets, newTabTargetFields)

        return target
      })
    }

    let target = await getTarget()

    if (!target) {
      debug('waiting for target %o to be created', newTabTargetFields)
      let timeout
      const timeoutPromise = new Promise((resolve) => {
        timeout = setTimeout(() => {
          debug('timed out waiting for target %o created/changed event, searching all targets', newTabTargetFields)
          getTarget().then(resolve)
        }, 15000)
      })

      const eventHandler = (resolve) => {
        return ({ targetInfo }) => {
          if (_.isMatch(targetInfo, newTabTargetFields)) {
            clearTimeout(timeout)
            resolve({ ...targetInfo, webSocketDebuggerUrl: `ws://${connectOpts.host}:${port}/devtools/page/${targetInfo.targetId}` })
          }
        }
      }

      debug('connecting to CRI on port %d', port)
      const client = await CRI(connectOpts)

      debug('enabling setDiscoverTargets')
      await client.Target.setDiscoverTargets({ discover: true })

      const targetPromise = new Promise((resolve) => {
        client.on('Target.targetCreated', eventHandler(resolve))
        client.on('Target.targetInfoChanged', eventHandler(resolve))
      })

      target = await Promise.race([
        targetPromise,
        timeoutPromise,
      ])

      await client.close()
    }

    la(target, 'could not find CRI target')

    debug('found CRI target %o', target)

    return target.webSocketDebuggerUrl
  })
}

module.exports = {
  _connectAsync,
  _getDelayMsForRetry,
  getWsTargetFor,
}
