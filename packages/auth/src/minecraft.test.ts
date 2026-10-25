import { describe, expect, it } from 'vitest'
import { MC_PROFILE_URL, profileResponse } from './__fixtures__/chain'
import { createFakeFetch, json } from './__fixtures__/fake-fetch'
import { pngHeader } from './__fixtures__/png'
import { currentTextures, getProfile, hideCape, parseProfile, resetSkin, setSkinUrl, showCape, uploadSkin } from './minecraft'

const SKINS_URL = `${MC_PROFILE_URL}/skins`
const ACTIVE_SKIN_URL = `${MC_PROFILE_URL}/skins/active`
const ACTIVE_CAPE_URL = `${MC_PROFILE_URL}/capes/active`
const slimProfile = { ...profileResponse, skins: [{ ...profileResponse.skins[0]!, variant: 'SLIM' }] }

describe('profile', () => {
  it('parses and normalises textures', async () => {
    const f = createFakeFetch({ [`GET ${MC_PROFILE_URL}`]: json(profileResponse) })
    const profile = await getProfile('tok', { fetch: f.fetch })
    expect(profile.id).toBe('069a79f444e94726a5befca90e38aaf5')
    expect(currentTextures(profile)).toEqual({
      SKIN: { url: 'http://textures.minecraft.net/texture/abc', metadata: { model: 'default' } },
      CAPE: { url: 'http://textures.minecraft.net/texture/cape' },
    })
    expect(currentTextures({ skins: [{ id: 'a', state: 'INACTIVE', url: 'u', variant: 'SLIM' }], capes: [] })).toEqual({
      SKIN: { url: 'u', metadata: { model: 'slim' } },
    })
  })

  it('drops malformed texture entries', () => {
    expect(parseProfile({ id: 'x', name: 'n', skins: [{ id: 1 }, null, { id: 's', url: 'u', variant: 'slim' }], capes: 'nope' })).toEqual({
      id: 'x',
      name: 'n',
      skins: [{ id: 's', state: 'INACTIVE', url: 'u', variant: 'SLIM' }],
      capes: [],
    })
    expect(parseProfile({ name: 'n' })).toBeUndefined()
  })

  it('maps 401 and non-JSON errors', async () => {
    const unauthorized = createFakeFetch({ [`GET ${MC_PROFILE_URL}`]: { status: 401, text: '' } })
    await expect(getProfile('tok', { fetch: unauthorized.fetch })).rejects.toMatchObject({ code: 'EMC_UNAUTHORIZED', status: 401 })
    const html = createFakeFetch({ [`GET ${MC_PROFILE_URL}`]: { status: 502, text: '<html>Bad gateway</html>' } })
    await expect(getProfile('tok', { fetch: html.fetch, retry: { attempts: 1 } })).rejects.toMatchObject({
      code: 'EMC_PROFILE_FAILED',
      body: '<html>Bad gateway</html>',
      retryable: true,
    })
  })
})

describe('skins and capes', () => {
  it('uploads a validated PNG as multipart', async () => {
    const png = pngHeader(64, 64)
    const f = createFakeFetch({ [`POST ${SKINS_URL}`]: json(slimProfile) })
    const profile = await uploadSkin({ accessToken: 'tok', png, variant: 'slim', fetch: f.fetch })
    expect(profile.skins[0]!.variant).toBe('SLIM')
    const call = f.calls[0]!
    expect(call.headers.get('authorization')).toBe('Bearer tok')
    const form = call.body as FormData
    expect(form.get('variant')).toBe('slim')
    const file = form.get('file') as File
    expect(file.type).toBe('image/png')
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(png)
  })

  it('refuses invalid images before any request', async () => {
    const f = createFakeFetch()
    await expect(uploadSkin({ accessToken: 'tok', png: pngHeader(128, 128), variant: 'classic', fetch: f.fetch })).rejects.toMatchObject({
      code: 'ESKIN_BAD_DIMENSIONS',
    })
    expect(f.calls).toHaveLength(0)
  })

  it('maps upload rejections, reading the body once', async () => {
    const png = pngHeader(64, 32)
    const rejected = createFakeFetch({
      [`POST ${SKINS_URL}`]: json({ path: '/minecraft/profile/skins', errorType: 'BAD_REQUEST', errorMessage: 'Invalid skin image: banned' }, 400),
    })
    await expect(uploadSkin({ accessToken: 't', png, variant: 'classic', fetch: rejected.fetch })).rejects.toMatchObject({ code: 'ESKIN_REJECTED_IMAGE' })
    const other = createFakeFetch({ [`POST ${SKINS_URL}`]: json({ errorMessage: 'Too many changes' }, 400) })
    await expect(uploadSkin({ accessToken: 't', png, variant: 'classic', fetch: other.fetch })).rejects.toMatchObject({
      code: 'ESKIN_REJECTED',
      message: 'Upload rejected: Too many changes',
    })
    // A non-JSON rejection body goes into the message, but never a token it happens to echo.
    const echoed = createFakeFetch({ [`POST ${SKINS_URL}`]: { status: 400, text: 'bad request for eyJhbGciOi.eyJzdWIiOiJ4In0.c2ln "accessToken":"secret-mc"' } })
    const e = await uploadSkin({ accessToken: 't', png, variant: 'classic', fetch: echoed.fetch }).catch((err: Error) => err)
    expect(e).toMatchObject({ code: 'ESKIN_REJECTED' })
    expect(JSON.stringify({ m: (e as Error).message, e })).not.toMatch(/eyJ|secret-mc/)
    const unauthorized = createFakeFetch({ [`POST ${SKINS_URL}`]: json({ error: 'UNAUTHORIZED' }, 401) })
    await expect(uploadSkin({ accessToken: 't', png, variant: 'classic', fetch: unauthorized.fetch })).rejects.toMatchObject({
      code: 'EMC_UNAUTHORIZED',
    })
  })

  it('sets a skin by URL', async () => {
    const f = createFakeFetch({ [`POST ${SKINS_URL}`]: json(profileResponse) })
    await setSkinUrl({ accessToken: 't', url: 'https://example.com/skin.png', variant: 'classic', fetch: f.fetch })
    expect(JSON.parse(f.calls[0]!.text!)).toEqual({ variant: 'classic', url: 'https://example.com/skin.png' })
    await expect(setSkinUrl({ accessToken: 't', url: 'file:///etc/passwd', variant: 'classic', fetch: f.fetch })).rejects.toMatchObject({
      code: 'ESKIN_REJECTED',
    })
  })

  it('resets the skin and re-fetches the profile', async () => {
    const f = createFakeFetch({ [`DELETE ${ACTIVE_SKIN_URL}`]: { status: 200, text: '' }, [`GET ${MC_PROFILE_URL}`]: json(profileResponse) })
    const profile = await resetSkin('t', { fetch: f.fetch })
    expect(profile.name).toBe('Notch')
    expect(f.calls.map((c) => c.method)).toEqual(['DELETE', 'GET'])
  })

  it('shows and hides capes', async () => {
    const f = createFakeFetch({
      [`PUT ${ACTIVE_CAPE_URL}`]: [json(profileResponse), json({ errorMessage: 'bad cape' }, 400)],
      [`DELETE ${ACTIVE_CAPE_URL}`]: json({ ...profileResponse, capes: [{ ...profileResponse.capes[0]!, state: 'INACTIVE' }] }),
    })
    await showCape('t', 'cape-1', { fetch: f.fetch })
    expect(JSON.parse(f.calls[0]!.text!)).toEqual({ capeId: 'cape-1' })
    await expect(showCape('t', 'not-owned', { fetch: f.fetch })).rejects.toMatchObject({ code: 'ECAPE_INVALID' })
    const hidden = await hideCape('t', { fetch: f.fetch })
    expect(currentTextures(hidden).CAPE).toBeUndefined()
  })
})
