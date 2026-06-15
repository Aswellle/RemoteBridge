export function Skeleton({ className = '' }: { className?: string }) {
  return (
    <div
      className={`animate-pulse rounded-md bg-secondary ${className}`}
      aria-hidden="true"
    />
  );
}
