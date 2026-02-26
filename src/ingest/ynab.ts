import { AppError } from "../errors";
import { EXIT, YNAB_BASE_URL } from "../constants";
import type { FintrackDb } from "../db";
import { getSyncCursor, setSyncCursor } from "../db/sync-state";
import { isoNow } from "../utils/time";
import type { Logger } from "../logger";

interface YnabResponse<T> {
  data: T;
}

interface BudgetListData {
  budgets: Array<{
    id: string;
    name: string;
    last_modified_on?: string;
  }>;
}

interface BudgetSingleData {
  budget: {
    id: string;
    name: string;
    last_modified_on?: string;
  };
}

interface TransactionsData {
  transactions: YnabTransaction[];
  server_knowledge: number;
}

interface ScheduledTransactionsData {
  scheduled_transactions: YnabScheduledTransaction[];
  server_knowledge: number;
}

export interface YnabTransaction {
  id: string;
  account_id?: string;
  account_name?: string;
  date: string;
  amount: number;
  payee_name?: string;
  memo?: string;
  cleared?: string;
  approved?: boolean;
  deleted?: boolean;
  transfer_account_id?: string;
  transfer_transaction_id?: string;
  parent_transaction_id?: string;
  category_name?: string;
  category_id?: string;
  debt_transaction_type?: string;
  import_id?: string;
  flag_color?: string;
  subtransactions?: Array<Record<string, unknown>>;
}

export interface YnabScheduledTransaction {
  id: string;
  account_id?: string;
  account_name?: string;
  date_first?: string;
  date_next?: string;
  frequency?: string;
  amount?: number;
  payee_name?: string;
  category_name?: string;
  deleted?: boolean;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export class YnabClient {
  constructor(private readonly token: string, private readonly logger: Logger) {}

  private async request<T>(path: string, search?: URLSearchParams): Promise<T> {
    const url = `${YNAB_BASE_URL}${path}${search ? `?${search.toString()}` : ""}`;

    const maxAttempts = 5;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const response = await fetch(url, {
        headers: {
          Authorization: `Bearer ${this.token}`,
          Accept: "application/json",
        },
      });

      if (response.status === 401 || response.status === 403) {
        throw new AppError("YNAB authentication failed", {
          exitCode: EXIT.AUTH_FAILURE,
          code: "YNAB_AUTH_FAILED",
        });
      }

      if ((response.status === 429 || response.status >= 500) && attempt < maxAttempts) {
        const base = Math.min(8000, 250 * 2 ** (attempt - 1));
        const jitter = Math.round(Math.random() * 250);
        const waitMs = base + jitter;
        this.logger.warn("YNAB request retry", { path, attempt, status: response.status, waitMs });
        await sleep(waitMs);
        continue;
      }

      if (!response.ok) {
        const payload = await response.text();
        throw new AppError("YNAB request failed", {
          exitCode: response.status === 429 ? EXIT.UPSTREAM_FAILURE : EXIT.RUNTIME,
          code: "YNAB_REQUEST_FAILED",
          details: { path, status: response.status, payload },
        });
      }

      const data = (await response.json()) as YnabResponse<T>;
      return data.data;
    }

    throw new AppError("YNAB rate limit retry budget exhausted", {
      exitCode: EXIT.UPSTREAM_FAILURE,
      code: "YNAB_RETRY_EXHAUSTED",
    });
  }

  async listBudgets(): Promise<BudgetListData["budgets"]> {
    const data = await this.request<BudgetListData>("/budgets");
    return data.budgets;
  }

  async getDefaultBudget(): Promise<BudgetSingleData["budget"]> {
    const data = await this.request<BudgetSingleData>("/budgets/default");
    return data.budget;
  }

  async getTransactionsDelta(
    budgetId: string,
    options: { lastKnowledgeOfServer?: number; sinceDate?: string }
  ): Promise<TransactionsData> {
    const query = new URLSearchParams();
    if (options.lastKnowledgeOfServer !== undefined) {
      query.set("last_knowledge_of_server", String(options.lastKnowledgeOfServer));
    } else if (options.sinceDate) {
      query.set("since_date", options.sinceDate);
    }
    return this.request<TransactionsData>(`/budgets/${budgetId}/transactions`, query);
  }

  async getScheduledTransactionsDelta(
    budgetId: string,
    options: { lastKnowledgeOfServer?: number }
  ): Promise<ScheduledTransactionsData> {
    const query = new URLSearchParams();
    if (options.lastKnowledgeOfServer !== undefined) {
      query.set("last_knowledge_of_server", String(options.lastKnowledgeOfServer));
    }
    return this.request<ScheduledTransactionsData>(`/budgets/${budgetId}/scheduled_transactions`, query);
  }
}

export const resolveBudgetSelection = async (
  client: YnabClient,
  selector: string
): Promise<{ id: string; name?: string }> => {
  if (selector === "default") {
    const budget = await client.getDefaultBudget();
    return { id: budget.id, name: budget.name };
  }

  if (selector === "last-used") {
    const budgets = await client.listBudgets();
    if (budgets.length === 0) {
      throw new AppError("No YNAB budgets available", {
        code: "YNAB_NO_BUDGETS",
      });
    }
    const sorted = [...budgets].sort((a, b) => {
      const ad = new Date(a.last_modified_on ?? 0).getTime();
      const bd = new Date(b.last_modified_on ?? 0).getTime();
      return bd - ad;
    });
    return { id: sorted[0].id, name: sorted[0].name };
  }

  return { id: selector };
};

const upsertTransaction = (db: FintrackDb, budgetId: string, txn: YnabTransaction): void => {
  db.db
    .query(
      `INSERT INTO raw_ynab_transaction (
        ynab_transaction_id, budget_id, account_id, account_name, date,
        amount_milliunits, payee_name, memo, cleared, approved, deleted,
        transfer_account_id, transfer_transaction_id, parent_transaction_id,
        category_name, category_id, debt_transaction_type, import_id, flag_color,
        raw_json, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(ynab_transaction_id) DO UPDATE SET
        budget_id = excluded.budget_id,
        account_id = excluded.account_id,
        account_name = excluded.account_name,
        date = excluded.date,
        amount_milliunits = excluded.amount_milliunits,
        payee_name = excluded.payee_name,
        memo = excluded.memo,
        cleared = excluded.cleared,
        approved = excluded.approved,
        deleted = excluded.deleted,
        transfer_account_id = excluded.transfer_account_id,
        transfer_transaction_id = excluded.transfer_transaction_id,
        parent_transaction_id = excluded.parent_transaction_id,
        category_name = excluded.category_name,
        category_id = excluded.category_id,
        debt_transaction_type = excluded.debt_transaction_type,
        import_id = excluded.import_id,
        flag_color = excluded.flag_color,
        raw_json = excluded.raw_json,
        updated_at = excluded.updated_at`
    )
    .run(
      txn.id,
      budgetId,
      txn.account_id ?? null,
      txn.account_name ?? null,
      txn.date,
      txn.amount,
      txn.payee_name ?? null,
      txn.memo ?? null,
      txn.cleared ?? null,
      txn.approved ? 1 : 0,
      txn.deleted ? 1 : 0,
      txn.transfer_account_id ?? null,
      txn.transfer_transaction_id ?? null,
      txn.parent_transaction_id ?? null,
      txn.category_name ?? null,
      txn.category_id ?? null,
      txn.debt_transaction_type ?? null,
      txn.import_id ?? null,
      txn.flag_color ?? null,
      JSON.stringify(txn),
      isoNow()
    );
};

const upsertScheduledTransaction = (db: FintrackDb, budgetId: string, txn: YnabScheduledTransaction): void => {
  db.db
    .query(
      `INSERT INTO raw_ynab_scheduled_transaction (
        ynab_scheduled_transaction_id, budget_id, account_id, account_name,
        date_first, date_next, frequency, amount_milliunits,
        payee_name, category_name, deleted, raw_json, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(ynab_scheduled_transaction_id) DO UPDATE SET
        budget_id = excluded.budget_id,
        account_id = excluded.account_id,
        account_name = excluded.account_name,
        date_first = excluded.date_first,
        date_next = excluded.date_next,
        frequency = excluded.frequency,
        amount_milliunits = excluded.amount_milliunits,
        payee_name = excluded.payee_name,
        category_name = excluded.category_name,
        deleted = excluded.deleted,
        raw_json = excluded.raw_json,
        updated_at = excluded.updated_at`
    )
    .run(
      txn.id,
      budgetId,
      txn.account_id ?? null,
      txn.account_name ?? null,
      txn.date_first ?? null,
      txn.date_next ?? null,
      txn.frequency ?? null,
      txn.amount ?? null,
      txn.payee_name ?? null,
      txn.category_name ?? null,
      txn.deleted ? 1 : 0,
      JSON.stringify(txn),
      isoNow()
    );
};

export interface SyncYnabOptions {
  budgetId: string;
  since?: string;
  dryRun?: boolean;
  resetCursor?: boolean;
  logger: Logger;
}

export interface SyncYnabResult {
  transactionsPulled: number;
  scheduledPulled: number;
  transactionServerKnowledge: number;
  scheduledServerKnowledge: number;
  usedTransactionCursor: boolean;
  usedScheduledCursor: boolean;
}

export const syncYnab = async (
  db: FintrackDb,
  client: YnabClient,
  options: SyncYnabOptions
): Promise<SyncYnabResult> => {
  const txScope = `budget:${options.budgetId}:transactions`;
  const scheduledScope = `budget:${options.budgetId}:scheduled_transactions`;

  const txCursor = options.resetCursor ? null : getSyncCursor(db, "ynab", txScope);
  const schedCursor = options.resetCursor ? null : getSyncCursor(db, "ynab", scheduledScope);

  const txDelta = await client.getTransactionsDelta(options.budgetId, {
    lastKnowledgeOfServer:
      typeof txCursor?.last_knowledge_of_server === "number"
        ? (txCursor.last_knowledge_of_server as number)
        : undefined,
    sinceDate:
      typeof txCursor?.last_knowledge_of_server === "number" ? undefined : options.since,
  });

  const scheduledDelta = await client.getScheduledTransactionsDelta(options.budgetId, {
    lastKnowledgeOfServer:
      typeof schedCursor?.last_knowledge_of_server === "number"
        ? (schedCursor.last_knowledge_of_server as number)
        : undefined,
  });

  if (!options.dryRun) {
    const tx = db.db.transaction(() => {
      for (const item of txDelta.transactions) {
        upsertTransaction(db, options.budgetId, item);
      }

      for (const item of scheduledDelta.scheduled_transactions) {
        upsertScheduledTransaction(db, options.budgetId, item);
      }

      setSyncCursor(db, "ynab", txScope, {
        last_knowledge_of_server: txDelta.server_knowledge,
        updated_at: isoNow(),
      });
      setSyncCursor(db, "ynab", scheduledScope, {
        last_knowledge_of_server: scheduledDelta.server_knowledge,
        updated_at: isoNow(),
      });
    });

    tx();
  }

  options.logger.info("YNAB sync complete", {
    budgetId: options.budgetId,
    transactionsPulled: txDelta.transactions.length,
    scheduledPulled: scheduledDelta.scheduled_transactions.length,
    transactionServerKnowledge: txDelta.server_knowledge,
    scheduledServerKnowledge: scheduledDelta.server_knowledge,
  });

  return {
    transactionsPulled: txDelta.transactions.length,
    scheduledPulled: scheduledDelta.scheduled_transactions.length,
    transactionServerKnowledge: txDelta.server_knowledge,
    scheduledServerKnowledge: scheduledDelta.server_knowledge,
    usedTransactionCursor: typeof txCursor?.last_knowledge_of_server === "number",
    usedScheduledCursor: typeof schedCursor?.last_knowledge_of_server === "number",
  };
};
