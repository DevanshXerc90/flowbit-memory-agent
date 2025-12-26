export type AuditEventType = 'recall' | 'apply' | 'decide' | 'learn';

export interface AuditEvent {
  id: string;
  type: AuditEventType;
  timestamp: Date;
  details: Record<string, unknown>;
}
