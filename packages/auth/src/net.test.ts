// Live checks against the real services. Run with AMETHYST_NET_TESTS=1 (and optionally
// AMETHYST_MSA_CLIENT_ID) to verify endpoint shapes and error mapping. No account is needed.
import { describe, expect, it } from 'vitest'
import { getProfile } from './minecraft'
import { startDeviceCode } from './oauth'
import { authenticateXbl } from './xbox'

describe.runIf(process.env.AMETHYST_NET_TESTS)('live services', () => {
  it('rejects a bogus Minecraft token with EMC_UNAUTHORIZED', async () => {
    await expect(getProfile('not-a-token')).rejects.toMatchObject({ code: 'EMC_UNAUTHORIZED' })
  })

  it('rejects a bogus Microsoft token at Xbox Live', async () => {
    await expect(authenticateXbl('not-a-token', { retry: { attempts: 1 } })).rejects.toMatchObject({ code: 'EXBL_FAILED' })
  })

  it.runIf(process.env.AMETHYST_MSA_CLIENT_ID)('issues a device code', async () => {
    const device = await startDeviceCode({ clientId: process.env.AMETHYST_MSA_CLIENT_ID! })
    expect(device.userCode).toMatch(/\w+/)
    expect(device.verificationUri).toMatch(/^https:\/\//)
    expect(device.expiresAt).toBeGreaterThan(Date.now())
  })
})
