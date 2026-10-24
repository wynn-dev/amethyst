import { Button, Sheet } from '@/ui'
import { PRIVACY_FIELDS, PRIVACY_FOOTNOTE } from '@/data/privacy'

/** "Learn more…": the exact fields each telemetry toggle covers. Shared by first run and Settings. */
export function PrivacyDetailsSheet({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title="What Amethyst collects"
      description="Only when you turn on the matching toggle. Both are off by default."
      width={520}
      footer={
        <Button variant="primary" onClick={() => onOpenChange(false)}>
          Done
        </Button>
      }
    >
      <div className="flex flex-col gap-4">
        {PRIVACY_FIELDS.map((g) => (
          <section key={g.title} aria-label={g.title}>
            <h3 className="mb-1 text-body font-semibold">{g.title}</h3>
            <ul className="flex list-disc flex-col gap-0.5 pl-5 text-body text-label-2 marker:text-label-3">
              {g.items.map((i) => (
                <li key={i}>{i}</li>
              ))}
            </ul>
          </section>
        ))}
        <p className="text-small text-label-2">{PRIVACY_FOOTNOTE}</p>
      </div>
    </Sheet>
  )
}
