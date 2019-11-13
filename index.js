// @ts-check
const core = require('@actions/core')
const exec = require('@actions/exec')
const io = require('@actions/io')
const hasha = require('hasha')
const execa = require('execa')
const { restoreCache, saveCache } = require('cache/lib/index')
const fs = require('fs')
const os = require('os')
const path = require('path')
const quote = require('quote')
const cliParser = require('argument-vector')()

const homeDirectory = os.homedir()

const useYarn = fs.existsSync('yarn.lock')
const lockFilename = useYarn ? 'yarn.lock' : 'package-lock.json'
const lockHash = hasha.fromFileSync(lockFilename)
const platformAndArch = `${process.platform}-${process.arch}`

// enforce the same NPM cache folder across different operating systems
const NPM_CACHE_FOLDER = path.join(homeDirectory, '.npm')
const NPM_CACHE = (() => {
  const o = {}
  if (useYarn) {
    o.inputPath = path.join(homeDirectory, '.cache', 'yarn')
    o.restoreKeys = `yarn-${platformAndArch}-`
  } else {
    o.inputPath = NPM_CACHE_FOLDER
    o.restoreKeys = `npm-${platformAndArch}-`
  }
  o.primaryKey = o.restoreKeys + lockHash
  return o
})()

// custom Cypress binary cache folder
// see https://on.cypress.io/caching
const CYPRESS_CACHE_FOLDER = path.join(homeDirectory, '.cache', 'Cypress')
console.log('using custom Cypress cache folder "%s"', CYPRESS_CACHE_FOLDER)

const CYPRESS_BINARY_CACHE = (() => {
  const o = {
    inputPath: CYPRESS_CACHE_FOLDER,
    restoreKeys: `cypress-${platformAndArch}-`
  }
  o.primaryKey = o.restoreKeys + lockHash
  return o
})()

const restoreCachedNpm = () => {
  console.log('trying to restore cached NPM modules')
  return restoreCache(
    NPM_CACHE.inputPath,
    NPM_CACHE.primaryKey,
    NPM_CACHE.restoreKeys
  )
}

const saveCachedNpm = () => {
  console.log('saving NPM modules')
  return saveCache(NPM_CACHE.inputPath, NPM_CACHE.primaryKey)
}

const restoreCachedCypressBinary = () => {
  console.log('trying to restore cached Cypress binary')
  return restoreCache(
    CYPRESS_BINARY_CACHE.inputPath,
    CYPRESS_BINARY_CACHE.primaryKey,
    CYPRESS_BINARY_CACHE.restoreKeys
  )
}

const saveCachedCypressBinary = () => {
  console.log('saving Cypress binary')
  return saveCache(
    CYPRESS_BINARY_CACHE.inputPath,
    CYPRESS_BINARY_CACHE.primaryKey
  )
}

const install = () => {
  // prevent lots of progress messages during install
  core.exportVariable('CI', '1')
  core.exportVariable('CYPRESS_CACHE_FOLDER', CYPRESS_CACHE_FOLDER)

  // Note: need to quote found tool to avoid Windows choking on
  // npm paths with spaces like "C:\Program Files\nodejs\npm.cmd ci"

  if (useYarn) {
    console.log('installing NPM dependencies using Yarn')
    return io.which('yarn', true).then(yarnPath => {
      console.log('yarn at "%s"', yarnPath)
      return exec.exec(quote(yarnPath), ['--frozen-lockfile'])
    })
  } else {
    console.log('installing NPM dependencies')
    core.exportVariable('npm_config_cache', NPM_CACHE_FOLDER)

    return io.which('npm', true).then(npmPath => {
      console.log('npm at "%s"', npmPath)
      return exec.exec(quote(npmPath), ['ci'])
    })
  }
}

const verifyCypressBinary = () => {
  console.log('Verifying Cypress')
  core.exportVariable('CYPRESS_CACHE_FOLDER', CYPRESS_CACHE_FOLDER)
  return io.which('npx', true).then(npxPath => {
    return exec.exec(quote(npxPath), ['cypress', 'verify'])
  })
}

/**
 * Grabs a boolean GitHub Action parameter input and casts it.
 * @param {string} name - parameter name
 * @param {boolean} defaultValue - default value to use if the parameter was not specified
 * @returns {boolean} converted input argument or default value
 */
const getInputBool = (name, defaultValue = false) => {
  const param = core.getInput(name)
  if (param === 'true' || param === '1') {
    return true
  }
  if (param === 'false' || param === '0') {
    return false
  }

  return defaultValue
}

const buildAppMaybe = () => {
  const buildApp = core.getInput('build')
  if (!buildApp) {
    return
  }

  console.log('building application using "%s"', buildApp)

  return exec.exec(buildApp)
}

const startServerMaybe = () => {
  let startCommand

  if (os.platform() === 'win32') {
    // allow custom Windows start command
    startCommand = core.getInput('start-windows') || core.getInput('start')
  } else {
    startCommand = core.getInput('start')
  }
  if (!startCommand) {
    console.log('No start command found')
    return
  }

  console.log('starting server with command "%s"', startCommand)
  console.log('current working directory "%s"', process.cwd())

  const args = cliParser.parse(startCommand)
  console.log('parsed command:', args.join(' '))
  return io.which(args[0], true).then(toolPath => {
    console.log('found command "%s"', toolPath)
    console.log('with arguments', args.slice(1).join(' '))

    const options = {
      shell: true,
      detached: true,
      stdio: 'inherit'
    }
    // if (os.platform() === 'win32') {
    //   // @ts-ignore
    //   options.shell = 'C:\\windows\\system32\\cmd.exe'
    // }

    // const childProcess = execa(quote(toolPath), args.slice(1), options)
    // allow child process to run in the background
    // https://nodejs.org/api/child_process.html#child_process_options_detached
    // childProcess.unref()
    // console.log('child process unref')

    const toolArguments = args.slice(1)
    console.log('running %s %s', quote(toolPath), toolArguments.join(' '))
    console.log('without waiting for the promise to resolve')
    exec.exec(quote(toolPath), toolArguments)
  })
}

const waitOnMaybe = () => {
  const waitOn = core.getInput('wait-on')
  if (!waitOn) {
    return
  }

  console.log('waiting on "%s"', waitOn)

  return io.which('npx', true).then(npxPath => {
    return exec.exec(quote(npxPath), ['wait-on', quote(waitOn)])
  })
}

const runTests = () => {
  const runTests = getInputBool('runTests', true)
  if (!runTests) {
    console.log('Skipping running tests: runTests parameter is false')
    return
  }

  console.log('Running Cypress tests')

  const record = getInputBool('record')
  const parallel = getInputBool('parallel')

  return io.which('npx', true).then(npxPath => {
    core.exportVariable('CYPRESS_CACHE_FOLDER', CYPRESS_CACHE_FOLDER)

    const cmd = ['cypress', 'run']
    if (record) {
      cmd.push('--record')
    }
    if (parallel) {
      // on GitHub Actions we can use workflow name and SHA commit to tie multiple jobs together
      const parallelId = `${process.env.GITHUB_WORKFLOW} - ${
        process.env.GITHUB_SHA
      }`
      cmd.push(`--parallel`)
      cmd.push('--ci-build-id')
      cmd.push(quote(parallelId))
    }
    const group = core.getInput('group')
    if (group) {
      cmd.push('--group')
      cmd.push(quote(group))
    }
    console.log('Cypress test command: npx %s', cmd.join(' '))

    core.exportVariable('TERM', 'xterm')
    // since we have quoted arguments ourselves, do not double quote them
    return exec.exec(quote(npxPath), cmd, {
      windowsVerbatimArguments: false
    })
  })
}

Promise.all([restoreCachedNpm(), restoreCachedCypressBinary()])
  .then(([npmCacheHit, cypressCacheHit]) => {
    console.log('npm cache hit', npmCacheHit)
    console.log('cypress cache hit', cypressCacheHit)

    return install().then(() => {
      if (npmCacheHit && cypressCacheHit) {
        console.log('no need to verify Cypress binary or save caches')
        return
      }

      return verifyCypressBinary()
        .then(saveCachedNpm)
        .then(saveCachedCypressBinary)
    })
  })
  .then(buildAppMaybe)
  .then(startServerMaybe)
  .then(waitOnMaybe)
  .then(runTests)
  .then(() => {
    console.log('all done, exiting')
    // force exit to avoid waiting for child processes,
    // like the server we have started
    // see https://github.com/actions/toolkit/issues/216
    process.exit(0)
  })
  .catch(error => {
    console.log(error)
    core.setFailed(error.message)
    process.exit(1)
  })
