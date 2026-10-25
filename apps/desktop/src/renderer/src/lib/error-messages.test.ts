import { describe, expect, it } from 'vitest'
import { describeError, errorMessage, MAPPED_CODES } from './error-messages'

/**
 * Every error code that can reach the user through an RPC rejection, a task error or a
 * `launch:state` failure. Adding a code to a package or runtime service? Add it here and give it
 * a message in error-messages.ts.
 */
const USER_FACING_CODES = {
  rpc: ['ERUNTIME_RESTARTED', 'ENOMETHOD', 'ECANCELLED', 'EBUSY', 'ENOT_FOUND', 'EINVALID_ARGUMENT', 'EUNAVAILABLE'],
  filesystem: ['ENOSPC', 'EROFS', 'EACCES', 'EPERM', 'EPERMISSION', 'ENOENT', 'EEXIST'],
  network: ['ENETWORK', 'ETIMEOUT', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ECONNRESET', 'ECONNABORTED', 'ENETUNREACH', 'ENETDOWN', 'EHOSTUNREACH', 'EHOSTDOWN', 'EPIPE', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_SOCKET', 'UND_ERR_CLOSED', 'ERR_HTTP2_STREAM_ERROR', 'ERR_HTTP2_SESSION_ERROR', 'ERR_HTTP2_GOAWAY_SESSION', 'ERR_STREAM_PREMATURE_CLOSE'],
  net: ['EHTTP', 'ECHECKSUM', 'ESIZE', 'EBADRESPONSE', 'ECONFLICT', 'EDOWNLOAD'],
  marketplace: ['ECF_NO_KEY', 'ECF_FORBIDDEN', 'ERATE_LIMITED', 'EBAD_RESPONSE', 'EMARKET_UNAVAILABLE', 'ENO_FILE', 'EUNSUPPORTED', 'EMANUAL_DOWNLOAD_REQUIRED', 'ENO_COMPATIBLE_VERSION'],
  content: ['EINVALID_ZIP', 'ENOT_A_WORLD', 'EUNSUPPORTED_FILE', 'ENO_SHADER_LOADER', 'EFAILED', 'ETRASH_FAILED'],
  zip: ['EZIP_MALFORMED', 'EZIP_NOT_FOUND', 'EZIP_UNSAFE_PATH', 'EZIP_TOO_LARGE'],
  nbt: ['ENBT_MALFORMED'],
  modpack: ['ENOT_A_FILE', 'ENOT_A_ZIP', 'EUNKNOWN_FORMAT', 'EINVALID_MANIFEST', 'EUNSUPPORTED_FORMAT', 'EINSTALL_INCOMPLETE', 'EINSTANCE_GONE', 'ECOMMIT', 'EDIFFERENT_UPSTREAM', 'EINSTALL_FAILED'],
  instances: ['EINSTANCE_UNAVAILABLE', 'EINVALID_NAME', 'ENAME_TAKEN', 'ERESCUE_FAILED', 'EIMPORT_REJECTED', 'EDOCUMENT_READONLY'],
  settings: ['EINVALID_SETTINGS', 'EUNSUPPORTED_MEDIA'],
  index: ['EDB_RESTARTED', 'EDB_UNAVAILABLE', 'EDB_OPEN_FAILED', 'EWORKER_CRASHED'],
  installer: ['EINSTALL_NOT_FOUND', 'EINSTALL_BAD_METADATA', 'EINSTALL_BAD_INSTALLER', 'EINSTALL_UNVERIFIED', 'EINSTALL_CHECKSUM', 'EINSTALL_FILE_INVALID', 'EINSTALL_UNKNOWN_VARIABLE', 'EINSTALL_PROCESSOR_BAD_JAR', 'EINSTALL_PROCESSOR_NO_MAIN_CLASS', 'EINSTALL_PROCESSOR_FAILED', 'EINSTALL_PROCESSOR_OUTPUT', 'EINSTALL_NO_JAVA', 'EINSTALL_UNSUPPORTED'],
  game: ['EVERSION_MISSING', 'EVERSION_CORRUPT', 'EVERSION_INVALID', 'EVERSION_CYCLE', 'ENATIVES_UNAVAILABLE', 'ENATIVES_EXTRACT', 'ELIBRARY_PATH', 'ELOG_CONFIG_MISSING', 'EASSET_INDEX', 'ELAUNCH_JAVA_NOT_FOUND', 'ELAUNCH_JAVA_PERMISSION', 'ELAUNCH_SPAWN', 'ELAUNCH_OPTIONS'],
  launch: ['EJAVA_REQUIRED', 'EACCOUNT_REQUIRED', 'ESIGN_IN_REQUIRED', 'EPRELAUNCH_FAILED', 'ELAUNCH_FAILED'],
  java: ['EJAVA_INVALID', 'EJAVA_PROBE', 'EJAVA_TIMEOUT', 'EBADARCH', 'ENORUNTIME', 'EBADMANIFEST', 'EUNSAFEPATH', 'EBADARCHIVE', 'ELZMA', 'EVERIFY', 'EINSTALL'],
  auth: [
    'EMSA_CANCELLED', 'EMSA_INVALID_GRANT', 'EMSA_INTERACTION_REQUIRED', 'EMSA_TOKEN_FAILED', 'EMSA_NO_REFRESH_TOKEN', 'EMSA_STATE_MISMATCH', 'EMSA_NO_CODE', 'EMSA_APP_NOT_APPROVED',
    'ELOGIN_TIMEOUT', 'EDEVICE_DECLINED', 'EDEVICE_EXPIRED', 'EDEVICE_BAD_CODE', 'EACCOUNT_MISMATCH', 'EXBL_FAILED',
    'EXSTS_BANNED', 'EXSTS_PARENTAL_CONTROLS', 'EXSTS_NO_ACCOUNT', 'EXSTS_TERMS_NOT_ACCEPTED', 'EXSTS_REGION_UNAVAILABLE', 'EXSTS_AGE_VERIFICATION', 'EXSTS_CHILD_NOT_IN_FAMILY', 'EXSTS_SERVICE_OUTAGE', 'EXSTS_UNKNOWN', 'EXSTS_BAD_RESPONSE',
    'EMC_ACCOUNT_SUSPENDED', 'EMC_RATE_LIMITED', 'EMC_SERVICE_ERROR', 'EMC_LOGIN_FAILED', 'EMC_NO_PROFILE', 'EMC_NOT_OWNED', 'EMC_UNAUTHORIZED', 'EMC_PROFILE_FAILED',
    'ESKIN_INVALID_PNG', 'ESKIN_BAD_DIMENSIONS', 'ESKIN_TOO_LARGE', 'ESKIN_REJECTED_IMAGE', 'ESKIN_REJECTED', 'ECAPE_INVALID',
    'EOFFLINE_NAME_REQUIRED', 'EOFFLINE_NAME_LENGTH', 'EOFFLINE_NAME_CYRILLIC', 'EOFFLINE_NAME_CHARS', 'EOFFLINE_UUID_INVALID', 'EOFFLINE_NOT_ALLOWED', 'ESESSION_INVALID',
  ],
  host: ['ESECRET_UNAVAILABLE', 'EAUTH_WINDOW', 'EOPEN_FAILED', 'ENOUPDATE'],
}

const ALL = Object.values(USER_FACING_CODES).flat()

describe('error messages', () => {
  it.each(ALL)('maps %s', (code) => {
    expect(MAPPED_CODES.has(code)).toBe(true)
    const f = describeError({ code, message: 'Raw message' })
    expect(f.code).toBe(code)
    expect(f.title.trim()).not.toBe('')
    expect(f.title).not.toMatch(/^[a-z]/)
  })

  it('names the platform for network failures', () => {
    expect(describeError({ code: 'ENOTFOUND', message: 'getaddrinfo', details: { platform: 'modrinth' } }).title).toBe('Couldn’t reach Modrinth')
    expect(describeError({ code: 'ENOTFOUND', message: 'getaddrinfo' }).title).toBe('Couldn’t connect')
    expect(describeError({ code: 'EHTTP', message: 'HTTP 500' }).title).toBe('The server returned an error')
  })

  it('uses the service message for service-worded codes and unknown codes', () => {
    expect(describeError({ code: 'ENAME_TAKEN', message: 'An instance named “A” already exists' }).title).toBe('An instance named “A” already exists')
    expect(describeError(new Error('Plain failure')).title).toBe('Plain failure')
    expect(describeError({ code: 'ESOMETHING_NEW', message: '' }).title).toBe('Something went wrong')
  })

  it('reads details for Java and the pre-launch command', () => {
    expect(describeError({ code: 'EJAVA_REQUIRED', message: '', details: { major: 21 } }).title).toBe('Minecraft needs Java 21')
    expect(describeError({ code: 'EJAVA_INVALID', message: '', details: { reason: 'bad-cpu-type' } }).message).toBe('It was built for a different processor.')
    expect(describeError({ code: 'EPRELAUNCH_FAILED', message: '', details: { exitCode: 2 } }).message).toMatch(/code 2/)
  })

  it('passes help links through', () => {
    expect(describeError({ code: 'EXSTS_NO_ACCOUNT', message: '', details: { link: 'https://xbox.com' } }).link).toBe('https://xbox.com')
  })

  it('joins title and message into punctuated sentences', () => {
    expect(errorMessage({ code: 'ENOSPC', message: '' })).toBe('Your disk is full. Free up some space and try again.')
    expect(errorMessage({ code: 'ECANCELLED', message: '' })).toBe('Cancelled.')
    expect(errorMessage({ code: 'EDIFFERENT_UPSTREAM', message: '' })).toBe('This instance follows a different modpack.')
  })
})
