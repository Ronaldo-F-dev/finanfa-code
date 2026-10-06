import { resolveBrand, tileColors } from "../brands";

/**
 * The logo of a connector or channel on a rounded tile: the service's own mark when we have it, otherwise its
 * initials on the brand colour (a neutral grey for a connector we don't know). Decorative: the name is always
 * written next to it, so it is hidden from screen readers.
 */
export function BrandLogo({ id, size = 36 }: { id: string; size?: number }) {
  const brand = resolveBrand(id);
  const { background, color } = tileColors(brand.color);
  return (
    <span className="brand-logo" aria-hidden="true" style={{ width: size, height: size, background, color, fontSize: Math.round(size * 0.36) }}>
      {brand.path ? (
        <svg viewBox="0 0 24 24" width={Math.round(size * 0.56)} height={Math.round(size * 0.56)} fill="currentColor">
          <path d={brand.path} />
        </svg>
      ) : (
        <span className="brand-logo-initials">{brand.initials}</span>
      )}
    </span>
  );
}
