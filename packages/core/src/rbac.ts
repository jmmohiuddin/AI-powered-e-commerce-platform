/**
 * ROLE-BASED ACCESS CONTROL
 *
 * Permissions are `resource:action` strings with a single-level wildcard.
 * Deliberately not a full policy language: an expressive engine nobody
 * understands produces permissive rules written by people guessing, which is
 * worse than a blunt model everybody reads correctly.
 *
 * Roles are per-tenant rows in the database; the definitions below are only the
 * defaults seeded for a new tenant. A merchant can add "Warehouse Supervisor —
 * stock yes, margins no" without a deploy.
 */

export const PERMISSIONS = [
  'product:read',
  'product:write',
  'product:delete',
  'category:write',
  'inventory:read',
  'inventory:adjust',
  'purchase:read',
  'purchase:write',
  'supplier:write',
  'order:read',
  'order:write',
  'order:cancel',
  'order:refund',
  'return:manage',
  'customer:read',
  'customer:write',
  // Reading personal data is separated from reading a customer record, so a
  // support agent can see order history without seeing phone numbers.
  'customer:read_pii',
  'discount:write',
  'campaign:read',
  'campaign:write',
  'campaign:send',
  // Cost and margin are their own permission. Plenty of staff need to fulfil
  // orders; very few need to know what the business pays per unit.
  'finance:read',
  'finance:export',
  'settings:read',
  'settings:write',
  'payment:configure',
  'user:manage',
  'role:manage',
  'audit:read',
  'ai:use',
  'ai:configure',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

/** `*` = everything, `order:*` = every action on orders. */
export type PermissionPattern = Permission | '*' | `${string}:*`;

export function hasPermission(
  granted: readonly string[],
  required: Permission,
): boolean {
  if (granted.includes('*')) return true;
  if (granted.includes(required)) return true;
  const [resource] = required.split(':');
  return granted.includes(`${resource}:*`);
}

export function hasAllPermissions(
  granted: readonly string[],
  required: readonly Permission[],
): boolean {
  return required.every((p) => hasPermission(granted, p));
}

export function hasAnyPermission(
  granted: readonly string[],
  required: readonly Permission[],
): boolean {
  return required.some((p) => hasPermission(granted, p));
}

export interface RoleDefinition {
  readonly key: string;
  readonly name: string;
  readonly description: string;
  readonly permissions: readonly PermissionPattern[];
  /**
   * Roles that can move money or change permissions require a second factor.
   * Enforced at the session layer, not merely suggested in onboarding.
   */
  readonly requiresMfa: boolean;
}

export const SYSTEM_ROLES: readonly RoleDefinition[] = [
  {
    key: 'owner',
    name: 'Owner',
    description: 'Full control, including billing and user management.',
    permissions: ['*'],
    requiresMfa: true,
  },
  {
    key: 'admin',
    name: 'Administrator',
    description: 'Everything except transferring ownership and platform billing.',
    permissions: [
      'product:*',
      'category:write',
      'inventory:*',
      'purchase:*',
      'supplier:write',
      'order:*',
      'return:manage',
      'customer:*',
      'discount:write',
      'campaign:*',
      'finance:read',
      'settings:*',
      'payment:configure',
      'user:manage',
      'audit:read',
      'ai:*',
    ],
    requiresMfa: true,
  },
  {
    key: 'manager',
    name: 'Store Manager',
    description: 'Day-to-day trading: catalogue, orders, promotions, and reports.',
    permissions: [
      'product:read',
      'product:write',
      'category:write',
      'inventory:read',
      'inventory:adjust',
      'purchase:read',
      'order:read',
      'order:write',
      'order:cancel',
      'return:manage',
      'customer:read',
      'customer:read_pii',
      'discount:write',
      'campaign:read',
      'campaign:write',
      'finance:read',
      'settings:read',
      'ai:use',
    ],
    requiresMfa: true,
  },
  {
    key: 'support',
    name: 'Customer Support',
    description: 'Handles orders and customers. Cannot see cost or margin.',
    permissions: [
      'product:read',
      'inventory:read',
      'order:read',
      'order:write',
      'return:manage',
      'customer:read',
      'customer:read_pii',
      'ai:use',
    ],
    requiresMfa: false,
  },
  {
    key: 'warehouse',
    name: 'Warehouse Staff',
    description: 'Receives stock and fulfils orders. No pricing, no customer PII.',
    permissions: [
      'product:read',
      'inventory:read',
      'inventory:adjust',
      'purchase:read',
      'purchase:write',
      'order:read',
      'order:write',
    ],
    requiresMfa: false,
  },
  {
    key: 'marketing',
    name: 'Marketing',
    description: 'Campaigns, content and promotions. Read-only on commerce data.',
    permissions: [
      'product:read',
      'category:write',
      'order:read',
      'customer:read',
      'discount:write',
      'campaign:*',
      'ai:use',
    ],
    requiresMfa: false,
  },
  {
    key: 'accountant',
    name: 'Accountant',
    description: 'Financial reporting and exports. No catalogue or customer edits.',
    permissions: ['order:read', 'finance:read', 'finance:export', 'purchase:read', 'audit:read'],
    requiresMfa: true,
  },
  {
    key: 'viewer',
    name: 'Viewer',
    description: 'Read-only access to the dashboard.',
    permissions: ['product:read', 'inventory:read', 'order:read', 'campaign:read'],
    requiresMfa: false,
  },
];

export function expandRole(role: RoleDefinition): string[] {
  return [...role.permissions];
}

export function roleRequiresMfa(roleKey: string): boolean {
  return SYSTEM_ROLES.find((r) => r.key === roleKey)?.requiresMfa ?? false;
}
