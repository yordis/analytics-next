import { Browser } from 'playwright'
import { JSONValue } from '../../src/core/events'
import { getMetrics } from './benchmark'

const DEBUG = process.env.DEBUG ?? false

type ComparisonParams = {
  browser: Browser
  serverURL: string
  writeKey: string
  script: string
  key: string
}

export async function run(params: ComparisonParams) {
  async function load(
    browser: Browser,
    isNext: boolean,
    source: string,
    execution: string,
    key: string
  ) {
    const networkRequests: Array<{ url: string; data: JSONValue }> = []
    const bundleRequests: Array<string> = []
    const context = await browser.newContext()
    const page = await context.newPage()

    page.route('**', async (route) => {
      const request = route.request()

      if (
        request.url().includes('cdn.segment') ||
        request.url().includes('cdn-settings') ||
        request.url().includes('localhost') ||
        request.url().includes('unpkg')
      ) {
        if (
          request.url().includes('next-integrations') &&
          request.url().includes(key)
        ) {
          const obfuscatedKey = btoa(key).replace(/=/g, '')
          const obfuscatedUrl = request
            .url()
            .replace(new RegExp(key, 'g'), obfuscatedKey)
          bundleRequests.push(request.url())
          bundleRequests.push(obfuscatedUrl)
        } else {
          bundleRequests.push(request.url())
        }
        route.continue().catch(console.error)
        return
      }

      if (request.resourceType() === 'script') {
        await route.continue().catch(console.error)
      } else {
        try {
          // do not actually send data
          await route.fulfill({ body: 'ok!' }).catch(console.error)
        } catch (_err) {
          // there are cases where the runner finishes so fast that requests
          // are still in flight when the browser is closing
        }
      }

      let data: JSONValue
      try {
        data = JSON.parse(request.postData() ?? '{}')
      } catch (e) {
        data = null
      }

      const call = { url: request.url(), data }

      // do not Record GA calls because it thinks ajs-next is a bot and doesn't naturally trigger requests
      // we know GA works :)
      if (
        // clarity.ms uses multiple subdomains
        call.url.includes('clarity.ms') ||
        call.url.includes('doubleclick.net') ||
        // bot
        call.url.includes('googletagmanager') ||
        // bot
        call.url.includes('api-iam.intercom.io') ||
        // bot
        call.url.includes('bat.bing') ||
        // there's no need to assert on metrics, especially as they're sampled
        call.url.includes('api.segment.io/v1/m') ||
        (request.method() === 'POST' && data === null)
      ) {
        return
      }

      networkRequests.push(call)
    })

    const url =
      params.serverURL +
      (isNext ? '?type=next' : '?type=classic') +
      '&wk=' +
      source

    await page.goto(url)

    // This forces every timestamp to look exactly the same
    await page.evaluate('Date.prototype.toJSON = () => "<date>";')
    await page.evaluate('Date.prototype.getTime = () => 1614653469;')

    await page.waitForLoadState('networkidle')
    await page.waitForFunction(`window.analytics.initialized === true`)

    const codeEvaluation = await page.evaluate(execution)

    const cookies = await context.cookies()
    const localStorage: Record<string, string | null> = await page.evaluate(
      () => {
        return Object.keys(localStorage).reduce(function (obj, str) {
          obj[str] = window.localStorage.getItem(str)
          return obj
        }, {} as Record<string, string | null>)
      }
    )

    await page.waitForLoadState('networkidle')
    const metrics = await getMetrics(page)

    !DEBUG && (await page.close({ runBeforeUnload: true }))

    return {
      networkRequests,
      cookies,
      localStorage,
      codeEvaluation,
      metrics,
      bundleRequests,
    }
  }

  const [classic, next] = await Promise.all([
    load(params.browser, false, params.writeKey, params.script, params.key),
    load(params.browser, true, params.writeKey, params.script, params.key),
  ])

  return {
    next,
    classic,
  }
}
