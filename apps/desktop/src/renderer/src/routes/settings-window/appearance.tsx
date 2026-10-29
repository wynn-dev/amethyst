import { useState, useSyncExternalStore } from 'react'
import { ImageIcon } from 'lucide-react'
import type { AppearanceSettings } from '@shared/services'
import { Button, Form, FormSection, Segmented, Slider, Switch } from '@/ui'
import { backgroundUrl, useAppearance, usePatchAppearance, useSetBackground } from '@/data/appearance'
import { SettingRow } from './context'
import { AccentPicker, MiniWindow, ModePicker } from './appearance-pickers'

const darkQuery = typeof matchMedia === 'undefined' ? undefined : matchMedia('(prefers-color-scheme: dark)')
const subscribeDark = (fn: () => void) => {
  darkQuery?.addEventListener('change', fn)
  return () => darkQuery?.removeEventListener('change', fn)
}

/** Follows the system appearance live. */
function usePrefersDark() {
  return useSyncExternalStore(subscribeDark, () => darkQuery?.matches ?? false)
}

type Background = AppearanceSettings['background']

/** Mode and accent rows for Settings → General (B7.1), bound to the same appearance settings. */
export function AppearanceQuickRows() {
  const a = useAppearance()
  const patch = usePatchAppearance()
  return (
    <>
      <SettingRow row="appearance" label="Appearance" stacked>
        <ModePicker value={a.theme} onValueChange={(theme) => patch({ theme })} />
      </SettingRow>
      <SettingRow row="accent" label="Accent colour">
        <AccentPicker value={a.accentColor} onValueChange={(accentColor) => patch({ accentColor })} />
      </SettingRow>
    </>
  )
}

/** Settings → Appearance (B8): mode, accent, sidebar material and an optional background. */
export function AppearancePane() {
  const a = useAppearance()
  const patch = usePatchAppearance()
  const setBackground = useSetBackground()
  const systemDark = usePrefersDark()
  const bg = a.background
  const url = backgroundUrl(a)
  const previewScheme = a.theme === 'system' ? (systemDark ? 'dark' : 'light') : a.theme
  // Sliders preview locally and save once released (one write per gesture, not per pixel).
  const [blurDraft, setBlurDraft] = useState<number | null>(null)
  const blur = blurDraft ?? bg.blur
  const setBg = (p: Partial<Background>) => patch({ background: p })

  return (
    <Form>
      {/* Live preview of the main window with the current choices. */}
      <div className="flex justify-center">
        <MiniWindow
          scheme={previewScheme}
          translucent={a.vibrancy}
          background={{ kind: bg.kind, url, fit: bg.fit, blur, overlay: bg.overlay }}
          className="h-[112px] w-[184px] rounded-lg shadow-card"
        />
      </div>

      <FormSection>
        <SettingRow row="mode" label="Appearance" stacked>
          <ModePicker value={a.theme} onValueChange={(theme) => patch({ theme })} />
        </SettingRow>
        <SettingRow row="accent" label="Accent colour" description="Used for buttons, selection, focus rings and progress." stacked>
          <AccentPicker value={a.accentColor} onValueChange={(accentColor) => patch({ accentColor })} labels />
        </SettingRow>
      </FormSection>

      <FormSection title="Sidebar">
        <SettingRow
          row="translucent"
          label="Translucent sidebar"
          description="Shows the desktop through the sidebar. Off uses a solid sidebar. Reduce Transparency in macOS always uses solid surfaces."
          htmlFor="set-translucent"
        >
          <Switch id="set-translucent" checked={a.vibrancy} onCheckedChange={(vibrancy) => patch({ vibrancy })} />
        </SettingRow>
      </FormSection>

      <FormSection
        title="Background"
        footer="Off by default. Content panels stay solid on top of the background. Videos are muted, and pause while the window is hidden or minimised and when Reduce Motion is on."
      >
        <SettingRow row="background" label="Background" description={bg.kind === 'none' ? 'None' : bg.kind === 'image' ? 'Image' : 'Video'}>
          <div className="flex items-center gap-2">
            {url ? (
              bg.kind === 'image' ? (
                <img src={url} alt="" className="h-7 w-11 rounded-[4px] object-cover shadow-[0_0_0_0.5px_rgb(0_0_0/0.2)]" />
              ) : (
                <video src={url} muted preload="metadata" className="h-7 w-11 rounded-[4px] object-cover shadow-[0_0_0_0.5px_rgb(0_0_0/0.2)]" />
              )
            ) : (
              <span className="flex h-7 w-11 items-center justify-center rounded-[4px] border border-dashed border-label-3 text-label-3">
                <ImageIcon className="size-3.5" />
              </span>
            )}
            {url && (
              <Button disabled={setBackground.isPending} onClick={() => setBackground.mutate('clear')}>
                Remove
              </Button>
            )}
            <Button disabled={setBackground.isPending} onClick={() => setBackground.mutate('choose')}>
              {url ? 'Change…' : 'Choose Image or Video…'}
            </Button>
          </div>
        </SettingRow>
        {url && (
          <>
            <SettingRow row="background-fit" label="Fit">
              <Segmented<Background['fit']>
                aria-label="Background fit"
                value={bg.fit}
                onValueChange={(fit) => setBg({ fit })}
                options={[
                  { value: 'cover', label: 'Fill' },
                  { value: 'contain', label: 'Fit' },
                ]}
              />
            </SettingRow>
            <SettingRow row="background-blur" label="Blur">
              <div className="flex w-[220px] items-center gap-2">
                <Slider
                  aria-label="Background blur"
                  min={0}
                  max={30}
                  step={1}
                  value={blur}
                  onValueChange={setBlurDraft}
                  onValueCommit={(v) => {
                    setBg({ blur: v })
                    setBlurDraft(null)
                  }}
                  valueText={(v) => `${v} px`}
                  className="flex-1"
                />
                <span className="w-9 text-right text-small text-label-2 tabular">{blur}</span>
              </div>
            </SettingRow>
            <SettingRow
              row="background-overlay"
              label="Tint content pages"
              description="Draws the window colour over the background everywhere except Home, so text stays easy to read."
              htmlFor="set-bg-overlay"
            >
              <Switch id="set-bg-overlay" checked={bg.overlay} onCheckedChange={(overlay) => setBg({ overlay })} />
            </SettingRow>
          </>
        )}
      </FormSection>
    </Form>
  )
}
