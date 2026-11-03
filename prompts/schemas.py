"""The shape every prompt's reply must take, as OpenAI `response_format` objects (one per prompt in prompts.py).

    reply = await get_llm("qualify").chat(qualification_prompt(summary), response_format=QUALIFICATION)

LiteLLM translates the OpenAI `json_schema` form into each provider's own mechanism (OpenAI / Gemini /
DeepSeek natively, Anthropic and Groq through a forced tool call, Ollama through `format`). Each role's
`structured_output` (config.py -> AI.qualify / AI.email) can step down to plain JSON mode or nothing for a provider that rejects it — so the prompts still
describe the same shape in words, and prompts/parsing.py still reads replies leniently.

The schemas stick to the keywords every provider accepts in strict mode: an object root, every property
`required`, `additionalProperties: false`, and no min/max, pattern or format constraints (check those in code).
"""

from __future__ import annotations


def _response_format(name: str, schema: dict) -> dict:
    return {"type": "json_schema", "json_schema": {"name": name, "strict": True, "schema": schema}}


def _object(properties: dict, description: str | None = None) -> dict:
    obj = {"type": "object", "properties": properties, "required": list(properties), "additionalProperties": False}
    if description:
        obj["description"] = description
    return obj


_QUALIFIED = {"type": "boolean", "description": "true if the company plausibly has work for the candidate in the "
                                               "role asked about, false if not."}
_SITE_SUMMARY = {"type": "string", "description": "2 or 3 plain sentences on what the company does, who its "
                                                  "customers are and what its team works on, from the website text only."}
_NUMBER = {"type": "integer", "description": "The company's number, as given in brackets in the prompt."}
_SUBJECT = {"type": "string", "description": "The email subject line: 3-8 words, no emojis or dashes."}
_BODY = {"type": "string", "description": "The plain-text middle of the email: 2 or 3 short paragraphs "
                                          "(70 to 140 words) ending with the ask and a mention of the attached "
                                          "resume. No greeting, no lists, dashes or sign off."}


# ── site_scrape: summarize the business and decide if it is a fit ────────────
# `summary` comes before `qualified` on purpose: the model writes in property order, so it describes the
# business before it judges it.

# qualification_prompt -> {"summary": "...", "qualified": true}
QUALIFICATION = _response_format("qualification", _object({"summary": _SITE_SUMMARY, "qualified": _QUALIFIED}))

# qualification_batch_prompt -> {"results": [{"number": 1, "summary": "...", "qualified": true}, ...]}
QUALIFICATION_BATCH = _response_format("qualification_batch", _object({
    "results": {
        "type": "array",
        "description": "One result per business in the prompt.",
        "items": _object({"number": _NUMBER, "summary": _SITE_SUMMARY, "qualified": _QUALIFIED}),
    },
}))


# ── profile: read the resume into the candidate profile ──────────────────────
# "Unknown" is an empty string (or 0 years, [] lists): strict mode wants every property, and not every
# provider accepts null in a schema.

def _str(description: str) -> dict:
    return {"type": "string", "description": description}


def _strings(description: str) -> dict:
    return {"type": "array", "items": {"type": "string"}, "description": description}


# profile_prompt -> {"full_name": "...", ..., "opportunity_type": "internship", ...}
CANDIDATE_PROFILE = _response_format("candidate_profile", _object({
    "full_name": _str("The candidate's full name, or \"\" if not given."),
    "headline": _str("One line on who they are professionally, e.g. \"Final year computer science student "
                     "focused on backend development\"."),
    "summary": _str("2 to 4 plain sentences on their background, strongest experience and what they are "
                    "good at."),
    "skills": _strings("Their most relevant skills and tools, most important first, at most 15."),
    "experience_years": {"type": "number", "description": "Years of professional experience (internships "
                                                          "count as part of a year); 0 if none or unknown."},
    "education": _str("Highest or current degree, institution and year, or \"\"."),
    "target_roles": _strings("1 to 3 specific job titles they are best suited to apply for now."),
    "opportunity_type": {"type": "string", "enum": ["job", "internship", "either"],
                         "description": "What they should look for: a full time job, an internship, or either."},
    "phone": _str("Phone number as written, or \"\"."),
    "linkedin_url": _str("Their LinkedIn profile URL, or \"\"."),
    "portfolio_url": _str("Their portfolio, GitHub or personal site URL, or \"\"."),
}))


# ── cold_email: write the email ──────────────────────────────────────────────

# cold_email_prompt -> {"subject": "...", "body": "..."}
COLD_EMAIL = _response_format("cold_email", _object({"subject": _SUBJECT, "body": _BODY}))

# cold_email_batch_prompt -> {"emails": [{"number": 1, "subject": "...", "body": "..."}, ...]}
COLD_EMAIL_BATCH = _response_format("cold_email_batch", _object({
    "emails": {
        "type": "array",
        "description": "One email per business in the prompt.",
        "items": _object({"number": _NUMBER, "subject": _SUBJECT, "body": _BODY}),
    },
}))
