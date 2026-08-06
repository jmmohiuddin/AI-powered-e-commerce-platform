import { describe, expect, it } from 'vitest';
import { expandRole, hasAllPermissions, hasPermission, roleRequiresMfa, SYSTEM_ROLES } from './rbac';

describe('hasPermission', () => {
  it('matches exact grants', () => {
    expect(hasPermission(['order:read'], 'order:read')).toBe(true);
  });

  it('matches resource wildcards', () => {
    expect(hasPermission(['order:*'], 'order:refund')).toBe(true);
  });

  it('matches the global wildcard', () => {
    expect(hasPermission(['*'], 'role:manage')).toBe(true);
  });

  it('does not leak across resources', () => {
    expect(hasPermission(['order:*'], 'finance:read')).toBe(false);
  });

  it('denies by default on an empty grant list', () => {
    expect(hasPermission([], 'product:read')).toBe(false);
  });
});

describe('system roles', () => {
  it('keeps cost data away from support and warehouse staff', () => {
    for (const key of ['support', 'warehouse']) {
      const role = SYSTEM_ROLES.find((r) => r.key === key)!;
      expect(hasPermission(expandRole(role), 'finance:read')).toBe(false);
    }
  });

  it('keeps customer PII away from warehouse staff', () => {
    const warehouse = SYSTEM_ROLES.find((r) => r.key === 'warehouse')!;
    expect(hasPermission(expandRole(warehouse), 'customer:read_pii')).toBe(false);
  });

  it('prevents non-owners from managing roles', () => {
    const manager = SYSTEM_ROLES.find((r) => r.key === 'manager')!;
    expect(hasPermission(expandRole(manager), 'role:manage')).toBe(false);
  });

  it('requires MFA for every role that can move money', () => {
    for (const role of SYSTEM_ROLES) {
      const canMoveMoney = hasAllPermissions(expandRole(role), ['order:refund']);
      if (canMoveMoney) expect(role.requiresMfa).toBe(true);
    }
  });

  it('reports MFA requirements by key', () => {
    expect(roleRequiresMfa('owner')).toBe(true);
    expect(roleRequiresMfa('viewer')).toBe(false);
    expect(roleRequiresMfa('nonexistent')).toBe(false);
  });
});
