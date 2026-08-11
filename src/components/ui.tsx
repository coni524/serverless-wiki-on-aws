import Alert from '@cloudscape-design/components/alert';
import StatusIndicator from '@cloudscape-design/components/status-indicator';
import { useT } from '@/lib/i18n';

export function Loading({ label }: { label?: string }) {
  const t = useT();
  return <StatusIndicator type="loading">{label ?? t.common.loading}</StatusIndicator>;
}

export function ErrorText({ children }: { children: React.ReactNode }) {
  return <Alert type="error">{children}</Alert>;
}
