export const MODULE_TABLE_SEARCH_SPAN = {
  xs: 24,
  sm: 12,
  md: 8,
  lg: 6,
  xl: 6,
  xxl: 6,
} as const;

type ModuleTableSearchConfig = {
  labelWidth: "auto";
  defaultCollapsed: boolean;
  span: typeof MODULE_TABLE_SEARCH_SPAN;
  style: {
    margin: number;
    padding: string;
    borderBottom: string;
  };
};

export const moduleTableSearch = (
  overrides?: Partial<ModuleTableSearchConfig>,
): ModuleTableSearchConfig => ({
  labelWidth: "auto",
  defaultCollapsed: false,
  span: MODULE_TABLE_SEARCH_SPAN,
  style: {
    margin: 0,
    padding: "16px 24px",
    borderBottom: "1px solid var(--ant-color-border)",
  },
  ...overrides,
});

export const moduleTableStyle = {
  padding: "0 16px 16px",
} as const;

export const MODULE_TABLE_DEFAULT_PAGE_SIZE = 10;
export const MODULE_TABLE_PAGE_SIZE_OPTIONS: (string | number)[] = [
  "10",
  "20",
  "50",
  "100",
];

export const moduleTablePagination = {
  defaultPageSize: MODULE_TABLE_DEFAULT_PAGE_SIZE,
  pageSize: MODULE_TABLE_DEFAULT_PAGE_SIZE,
  showSizeChanger: true,
  pageSizeOptions: MODULE_TABLE_PAGE_SIZE_OPTIONS,
  hideOnSinglePage: true,
  style: { margin: "0 16px 16px" },
} as const;

/** Nested / detail-panel tables: same defaults, compact pager. */
export const moduleNestedTablePagination = {
  defaultPageSize: MODULE_TABLE_DEFAULT_PAGE_SIZE,
  pageSize: MODULE_TABLE_DEFAULT_PAGE_SIZE,
  showSizeChanger: true,
  pageSizeOptions: MODULE_TABLE_PAGE_SIZE_OPTIONS,
  hideOnSinglePage: true,
  size: "small" as const,
  style: { margin: "8px 0 0" },
} as const;

/** Vertical stack for multi-section module pages (matches timeline / knowledge-base rhythm). */
export const moduleSectionStackStyle = {
  display: "flex",
  flexDirection: "column",
  gap: 16,
  minWidth: 0,
  maxWidth: "100%",
} as const;

/** Filter row aligned with ProTable search bar chrome. */
export const moduleFilterBarStyle = {
  margin: 0,
  padding: "16px 24px",
  borderBottom: "1px solid var(--ant-color-border)",
  display: "flex",
  flexWrap: "wrap",
  gap: 12,
  alignItems: "center",
} as const;

/** Tabs nav padding when rendered inside ModuleTableCard. */
export const moduleTabsInCardStyle = {
  padding: "0 16px",
  marginBottom: 0,
} as const;

/** Minimum horizontal scroll width for module tables (enables fixed action columns). */
export const MODULE_TABLE_SCROLL_X = "max-content";

/** Shared ProTable props used by timeline, knowledge-base, and monitoring lists. */
export const moduleProTableProps = {
  ghost: true as const,
  cardProps: false as const,
  options: false as const,
  bordered: true as const,
  tableLayout: "fixed" as const,
  scroll: { x: MODULE_TABLE_SCROLL_X },
  style: { maxWidth: "100%" as const },
  tableStyle: moduleTableStyle,
  toolBarRender: () => [],
};

/** Compact nested table inside an expanded row detail panel. */
export const moduleNestedTableProps = {
  search: false as const,
  options: false as const,
  pagination: moduleNestedTablePagination,
  bordered: true as const,
  tableLayout: "fixed" as const,
  scroll: { x: MODULE_TABLE_SCROLL_X },
  size: "small" as const,
  ghost: true as const,
  cardProps: false as const,
  tableStyle: { padding: 0, margin: 0 },
  style: { margin: 0 },
  toolBarRender: () => [],
};

export const MODULE_TABLE_EXPAND_COLUMN_WIDTH = 36;
/** Ant Design default table cell inline padding (size middle). */
export const MODULE_TABLE_CELL_PADDING_INLINE = 16;

/** Align expanded detail with the first data column text (expand col + cell padding). */
export const moduleTableDetailIndent =
  MODULE_TABLE_EXPAND_COLUMN_WIDTH + MODULE_TABLE_CELL_PADDING_INLINE;

export const moduleTableExpandable = {
  columnWidth: MODULE_TABLE_EXPAND_COLUMN_WIDTH,
  expandedRowClassName: () => "module-table-expanded-row",
} as const;