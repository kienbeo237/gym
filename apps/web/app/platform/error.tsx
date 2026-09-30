'use client';

import { ErrorView } from '../../components/error-view';

export default function PlatformError(props: { error: Error & { digest?: string }; reset: () => void }) {
  return <ErrorView {...props} />;
}
