import { Button, Sheet, recentTrigger } from '@/ui'
import { PRIVACY_FIELDS, PRIVACY_FOOTNOTE } from '@/data/privacy'
import { Card, Note } from '@/routes/sheets/parts'

/** "Learn more…": the exact fields each telemetry toggle covers. Shared by first run and Settings. */
export function PrivacyDetailsSheet({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title="What Amethyst collects"
      description="Only when you turn on the matching toggle. Both are off by default."
      width={520}
      origin={recentTrigger}
      footer={
        <Button variant="primary" onClick={() => onOpenChange(false)}>
          Done
        </Button>
      }
    >
      <div className="flex flex-col gap-3">
        {PRIVACY_FIELDS.map((g) => (
          <Card key={g.title} title={g.title} count={g.items.length}>
            <ul className="flex flex-col divide-y divide-separator">
              {g.items.map((i) => (
                <li key={i} className="flex min-h-[32px] items-center px-3 py-1.5 text-compact">
                  {i}
                </li>
              ))}
            </ul>
          </Card>
        ))}
        <Note>{PRIVACY_FOOTNOTE}</Note>
      </div>
    </Sheet>
  )
}
