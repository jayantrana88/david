/** Row shapes of the pipeline's tables (daemon/db/schema.sql, migrations/), as the API returns them. */

export const TASK_STATUSES = ["pending", "running", "completed", "failed"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const OPPORTUNITY_TYPES = ["job", "internship", "either"] as const;
export type OpportunityType = (typeof OPPORTUNITY_TYPES)[number];

export type Task = {
  id: number;
  source: string;
  category: string;
  location: string;
  candidates: number;
  metro_radius_km: number | null;
  max_employees: number;
  target_role: string | null;
  opportunity_type: OpportunityType | null;
  status: TaskStatus;
  repeat_daily: boolean;
  leads_saved: number;
  error: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  updated_at: string;
};

export type Website = {
  id: string;
  name: string;
  website_url: string;
  email: string | null;
  phone_number: string | null;
  category: string | null;
  location: string | null;
  owner: string | null;
  source: string | null;
  employee_size: string | null;
  industry: string | null;
  linkedin_url: string | null;
  created_at: string;
};

export type Scrape = {
  id: string;
  website_id: string;
  is_qualified: boolean | null;
  summary: string | null;
  created_at: string;
  websites: { name: string; website_url: string } | null;
};

export type Page = {
  id: string;
  scrape_id: string;
  page_name: string;
  page_url: string | null;
  has_content: boolean;
  created_at: string;
  website_scrapes: { website_id: string; websites: { name: string; website_url: string } | null } | null;
};

export const EMAIL_STATUSES = ["draft", "sending", "sent", "send_failed", "rejected", "generation_failed"] as const;
export type EmailStatus = (typeof EMAIL_STATUSES)[number];

/** Where "send" mode delivers (config.py -> EMAIL.delivery): your Telegram chat, or a mailbox. */
export const EMAIL_DELIVERIES = ["telegram", "gmail", "outlook"] as const;
export type EmailDelivery = (typeof EMAIL_DELIVERIES)[number];
export const DELIVERY_LABEL: Record<EmailDelivery, string> = {
  telegram: "Telegram",
  gmail: "Gmail",
  outlook: "Outlook",
};

export type ColdEmail = {
  id: string;
  website_id: string;
  email_address: string;
  subject: string | null;
  body: string | null;
  attachment_name: string | null;
  delivery: EmailDelivery | null;
  status: EmailStatus;
  sent_at: string | null;
  created_at: string;
  websites: { name: string; website_url: string } | null;
};

/** The single `candidate_profile` row (db/schema.sql). */
export type CandidateProfile = {
  resume_path: string | null;
  resume_filename: string | null;
  resume_mime: string | null;
  career_notes: string | null;
  full_name: string | null;
  headline: string | null;
  summary: string | null;
  skills: string[];
  experience_years: number | null;
  education: string | null;
  target_roles: string[];
  opportunity_type: OpportunityType;
  phone: string | null;
  linkedin_url: string | null;
  portfolio_url: string | null;
  parse_status: "pending" | "done" | "failed" | null;
  parse_error: string | null;
  parsed_at: string | null;
  updated_at: string;
};

export type ListResult<T> = { rows: T[]; total: number };

/** What an action (a POST to the API) hands back to the form or button that called it. */
export type ActionResult = { ok: boolean; message: string; fieldErrors?: Record<string, string> } | null;
