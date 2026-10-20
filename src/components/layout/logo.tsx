export function Logo({ compact = false }: { compact?: boolean }) {
  return (
    <div className="flex items-center gap-2">
      <div className="flex size-7 items-center justify-center rounded-md bg-accent text-[13px] font-semibold text-accent-foreground">
        G
      </div>
      {!compact && <span className="text-[15px] font-semibold tracking-tight text-foreground">Gestion</span>}
    </div>
  );
}
