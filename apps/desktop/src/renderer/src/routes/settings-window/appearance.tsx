import { useSyncExternalStore } from 'react'
import { Button, Form, FormSection, Segmented, Slider, Switch } from '@/ui'
import { notYetAvailable } from '@/app/commands'
import { useSettings, useUpdateSettings, type Settings } from '@/data/settings'
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

/** Settings → Appearance (B8). */
export function AppearancePane() {
  const s = useSettings()
  const update = useUpdateSettings()
  const systemDark = usePrefersDark()
  const bg = s.background
  const setBg = (patch: Partial<Settings['background']>) => update({ background: { ...bg, ...patch } })
  const previewScheme = s.appearance === 'system' ? (systemDark ? 'dark' : 'light') : s.appearance

  return (
    <Form>
      {/* Live preview of the main window with the current choices. */}
      <div className="flex justify-center">
        <MiniWindow
          scheme={previewScheme}
          translucent={s.translucentSidebar}
          background={bg}
          className="h-[132px] w-[216px] rounded-lg shadow-card"
        />
      </div>

      <FormSection>
        <SettingRow row="mode" label="Appearance" stacked>
          <ModePicker value={s.appearance} onValueChange={(appearance) => update({ appearance })} />
        </SettingRow>
        <SettingRow row="accent" label="Accent colour" description="Used for buttons, selection, focus rings and progress." stacked>
          <AccentPicker value={s.accent} onValueChange={(accent) => update({ accent })} labels />
        </SettingRow>
      </FormSection>

      <FormSection title="Sidebar">
        <SettingRow row="translucent" label="Translucent sidebar" description="Off uses a solid sidebar. Reduce Transparency in macOS always uses solid surfaces." htmlFor="set-translucent">
          <Switch id="set-translucent" checked={s.translucentSidebar} onCheckedChange={(translucentSidebar) => update({ translucentSidebar })} />
        </SettingRow>
        <SettingRow row="icon-size" label="Sidebar icon size">
          <Segmented<Settings['sidebarIconSize']>
            aria-label="Sidebar icon size"
            value={s.sidebarIconSize}
            onValueChange={(sidebarIconSize) => update({ sidebarIconSize })}
            options={[
              { value: 'small', label: 'Small' },
              { value: 'medium', label: 'Medium' },
              { value: 'large', label: 'Large' },
            ]}
          />
        </SettingRow>
      </FormSection>

      <FormSection
        title="Background"
        footer="Content panels stay solid on top of the background. Videos pause while you play, while the window is hidden and in Low Power Mode."
      >
        <SettingRow row="background" label="Background">
          <Segmented<Settings['background']['kind']>
            aria-label="Background"
            value={bg.kind}
            onValueChange={(kind) => setBg({ kind })}
            options={[
              { value: 'none', label: 'None' },
              { value: 'image', label: 'Image' },
              { value: 'video', label: 'Video' },
            ]}
          />
        </SettingRow>
        {bg.kind !== 'none' && (
          <>
            <SettingRow row="background-file" label={bg.kind === 'image' ? 'Image' : 'Video'} description={bg.url ?? 'No file chosen'}>
              {bg.kind === 'image' && <Button onClick={() => notYetAvailable('Use Desktop Picture')}>Use Desktop Picture</Button>}
              <Button onClick={() => notYetAvailable('Choosing a background file')}>Choose File…</Button>
            </SettingRow>
            <SettingRow row="background-fit" label="Fit">
              <Segmented<Settings['background']['fit']>
                aria-label="Background fit"
                value={bg.fit}
                onValueChange={(fit) => setBg({ fit })}
                options={[
                  { value: 'fill', label: 'Fill' },
                  { value: 'fit', label: 'Fit' },
                ]}
              />
            </SettingRow>
            <SettingRow row="background-dim" label="Dim">
              <div className="flex w-[220px] items-center gap-2">
                <Slider aria-label="Dim" min={0} max={80} step={5} value={bg.dim} onValueChange={(dim) => setBg({ dim })} valueText={(v) => `${v}%`} className="flex-1" />
                <span className="w-9 text-right text-small text-label-2 tabular">{bg.dim}%</span>
              </div>
            </SettingRow>
            <SettingRow row="background-blur" label="Blur">
              <div className="flex w-[220px] items-center gap-2">
                <Slider aria-label="Blur" min={0} max={40} step={1} value={bg.blur} onValueChange={(blur) => setBg({ blur })} valueText={(v) => `${v} px`} className="flex-1" />
                <span className="w-9 text-right text-small text-label-2 tabular">{bg.blur}</span>
              </div>
            </SettingRow>
            {bg.kind === 'video' && (
              <SettingRow row="background-volume" label="Volume" description={bg.volume === 0 ? 'Muted' : undefined}>
                <div className="flex w-[220px] items-center gap-2">
                  <Slider aria-label="Video volume" min={0} max={100} step={5} value={bg.volume} onValueChange={(volume) => setBg({ volume })} valueText={(v) => `${v}%`} className="flex-1" />
                  <span className="w-9 text-right text-small text-label-2 tabular">{bg.volume}%</span>
                </div>
              </SettingRow>
            )}
          </>
        )}
      </FormSection>
    </Form>
  )
}
