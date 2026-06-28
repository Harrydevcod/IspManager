type SkeletonProps = {
  width?: string | number;
  height?: string | number;
  radius?: string | number;
  className?: string;
};

/** Shimmer placeholder. Respeita prefers-reduced-motion (ver styles.css). */
export function Skeleton({ width = '100%', height = 12, radius = 6, className }: SkeletonProps) {
  return (
    <span
      className={className ? `skeleton ${className}` : 'skeleton'}
      style={{ width, height, borderRadius: radius }}
      aria-hidden
    />
  );
}

/** Lista de linhas-esqueleto para placeholders de tabelas/listas durante o load. */
export function SkeletonList({ rows = 5 }: { rows?: number }) {
  return (
    <div className="skeleton-list" role="status" aria-label="A carregar">
      {Array.from({ length: rows }).map((_, i) => (
        <div className="skeleton-row" key={i}>
          <Skeleton width={36} height={36} radius={10} />
          <div className="skeleton-row-body">
            <Skeleton width="42%" height={13} />
            <Skeleton width="68%" height={11} />
          </div>
          <Skeleton width={64} height={20} radius={999} />
        </div>
      ))}
    </div>
  );
}
