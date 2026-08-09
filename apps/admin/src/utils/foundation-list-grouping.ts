import type { FoundationComponent } from "./monitoring-types";

export type FoundationProductGroup = {
  product: string;
  label: string;
  items: FoundationComponent[];
};

export function filterFoundationItems(
  items: FoundationComponent[],
  params: Record<string, unknown>,
): FoundationComponent[] {
  const displayName = String(params.display_name ?? "").trim().toLowerCase();
  const product = String(params.product ?? "").trim().toLowerCase();
  const version = String(params.version_range ?? "").trim().toLowerCase();
  const category = String(params.category ?? "").trim();

  return items.filter((row) => {
    if (displayName && !row.display_name.toLowerCase().includes(displayName)) return false;
    if (product && !row.product.toLowerCase().includes(product)) return false;
    if (version && !row.version_range.toLowerCase().includes(version)) return false;
    if (category && row.category !== category) return false;
    return true;
  });
}

function productGroupLabel(items: FoundationComponent[]): string {
  const primary = items.find((row) => row.display_name)?.display_name ?? items[0].product;
  const base = primary.replace(/\s+\d+(?:\.\d+)*.*$/, "").trim();
  if (base) return base;
  return items[0].product.charAt(0).toUpperCase() + items[0].product.slice(1);
}

export function groupFoundationByProduct(items: FoundationComponent[]): {
  singletons: FoundationComponent[];
  productGroups: FoundationProductGroup[];
} {
  const map = new Map<string, FoundationComponent[]>();
  for (const item of items) {
    const key = item.product.toLowerCase();
    const bucket = map.get(key) ?? [];
    bucket.push(item);
    map.set(key, bucket);
  }

  const singletons: FoundationComponent[] = [];
  const productGroups: FoundationProductGroup[] = [];

  for (const [product, versions] of map) {
    const sorted = [...versions].sort((a, b) =>
      a.version_range.localeCompare(b.version_range, undefined, { numeric: true }),
    );
    if (sorted.length === 1) {
      singletons.push(sorted[0]);
      continue;
    }
    productGroups.push({
      product,
      label: productGroupLabel(sorted),
      items: sorted,
    });
  }

  singletons.sort((a, b) => a.product.localeCompare(b.product));
  productGroups.sort((a, b) => a.product.localeCompare(b.product));
  return { singletons, productGroups };
}