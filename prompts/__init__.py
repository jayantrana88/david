"""Every LLM prompt, the schema of its reply and the parser of that reply, in one place."""
from prompts.parsing import parse_email_draft, parse_email_drafts, parse_json_object, parse_profile, parse_verdict, \
    parse_verdicts
from prompts.schemas import CANDIDATE_PROFILE, COLD_EMAIL, COLD_EMAIL_BATCH, QUALIFICATION, QUALIFICATION_BATCH
from prompts.templates import cold_email_batch_prompt, cold_email_prompt, profile_prompt, qualification_batch_prompt, \
    qualification_prompt

__all__ = [
    "CANDIDATE_PROFILE", "COLD_EMAIL", "COLD_EMAIL_BATCH", "QUALIFICATION", "QUALIFICATION_BATCH",
    "cold_email_batch_prompt", "cold_email_prompt", "parse_email_draft", "parse_email_drafts", "parse_json_object",
    "parse_profile", "parse_verdict", "parse_verdicts", "profile_prompt", "qualification_batch_prompt",
    "qualification_prompt",
]
