import { describe, expect, it } from 'vitest'
import { classifyAuthNavigation, isSignInHost, matchesRedirect } from './auth-navigation'

const REDIRECT = 'http://localhost:51234'

describe('sign-in window navigation policy', () => {
  it('allows the Microsoft, Live and Xbox sign-in hosts over https only', () => {
    for (const url of [
      'https://login.microsoftonline.com/consumers/oauth2/v2.0/authorize?client_id=x',
      'https://login.live.com/oauth20_authorize.srf?x=1',
      'https://login.microsoft.com/consumers/fido/get',
      'https://account.live.com/Consent/Update',
      'https://signup.live.com/signup',
      'https://account.microsoft.com/family',
      'https://sisu.xboxlive.com/connect/XboxLive',
      'https://account.xbox.com/en-us/profile',
    ]) {
      expect([url, classifyAuthNavigation(url, REDIRECT)]).toEqual([url, 'allow'])
    }
    for (const url of [
      'http://login.live.com/oauth20_authorize.srf',
      'https://login.live.com:8443/',
      'https://user:pw@login.live.com/',
      'https://login.live.com.evil.example/',
      'https://evil-login.live.com.example/',
      'https://xboxlive.com.evil.example/',
    ]) {
      expect([url, isSignInHost(url)]).toEqual([url, false])
    }
  })

  it('ends the flow on the loopback redirect, whichever loopback name the page uses', () => {
    expect(classifyAuthNavigation(`${REDIRECT}/?code=c&state=s`, REDIRECT)).toBe('redirect')
    expect(classifyAuthNavigation('http://127.0.0.1:51234/?code=c', REDIRECT)).toBe('redirect')
    expect(matchesRedirect('http://localhost:1/?code=c', REDIRECT)).toBe(false)
    expect(classifyAuthNavigation('http://localhost:1/?code=c', REDIRECT)).toBe('block')
  })

  it('sends other https pages to the browser and blocks every other scheme', () => {
    expect(classifyAuthNavigation('https://privacy.microsoft.com/privacystatement', REDIRECT)).toBe('external')
    expect(classifyAuthNavigation('https://evil.example/phish', REDIRECT)).toBe('external')
    for (const url of ['http://evil.example/', 'file:///etc/passwd', 'javascript:alert(1)', 'data:text/html,hi', 'amethyst-asset://x', 'not a url']) {
      expect([url, classifyAuthNavigation(url, REDIRECT)]).toEqual([url, 'block'])
    }
  })
})
