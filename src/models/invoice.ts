export interface InvoiceLineItem {
  id: string;
  description: string;
  quantity: number;
  unitPrice: number;
}

export interface Invoice {
  id: string;
  externalId?: string;
  customerName: string;
  currency: string;
  totalAmount: number;
  issuedAt: Date;
  dueAt?: Date;
  lineItems: InvoiceLineItem[];
  metadata?: Record<string, unknown>;
}
