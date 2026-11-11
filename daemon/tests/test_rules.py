"""The email rule check and the email's frame (greeting, signature)."""

from stages.email.models import Draft
from stages.email.recipients import greeting, pick_email
from stages.email.writer import check_rules, compose
from stages.profile.models import CandidateProfile

PROFILE = CandidateProfile(full_name="Asha Rao", phone="+91 99999 00000", linkedin_url="https://linkedin.com/in/asha",
                           target_roles=["Data Analyst"], parse_status="done")

GOOD_BODY = (
    "I came across your work on logistics dashboards for small retailers and it lines up closely with what I "
    "have been building in my final year projects with Python and SQL.\n\n"
    "Over the last year I cleaned and modelled sales data for a local cooperative, built weekly reports in "
    "Power BI and automated the exports, which saved the team several hours every week.\n\n"
    "I would love to help as a data analyst intern. My resume is attached and my profile is at "
    "https://linkedin.com/in/asha if you would like more detail."
)


def test_good_draft_passes():
    assert check_rules(Draft("Data analyst internship enquiry", GOOD_BODY), PROFILE.links(), attached=True) == []


def test_each_rule_reports_a_problem():
    def issues(subject=None, body=None, attached=True):
        return check_rules(Draft(subject or "Data analyst internship enquiry", body or GOOD_BODY),
                           PROFILE.links(), attached=attached)

    assert any("greeting" in i for i in issues(body="Hi team,\n\n" + GOOD_BODY))
    assert any("dash" in i for i in issues(body=GOOD_BODY.replace("closely with", "closely — with")))
    assert any("link" in i for i in issues(body=GOOD_BODY + " See https://example.org too."))
    assert any("words" in i for i in issues(body="Too short. My resume is attached."))
    assert any("bullet" in i for i in issues(body=GOOD_BODY + "\n- one point"))
    assert any("resume" in i for i in issues(body=GOOD_BODY.replace("My resume is attached and my", "My")))
    assert issues(body=GOOD_BODY.replace("My resume is attached and my", "My"), attached=False) == []
    assert any("subject" in i for i in issues(subject="Hi"))


def test_compose_adds_greeting_and_signature():
    text = compose("Acme Labs | Product Studio", "Body text.", PROFILE)
    assert text.startswith("Hi Acme Labs team,\n\nBody text.\n\nBest regards,\nAsha Rao")
    assert "+91 99999 00000" in text and "https://linkedin.com/in/asha" in text
    assert greeting("") == "Hi there,"


def test_pick_email_skips_junk():
    assert pick_email("noreply@acme.com, logo@2x.png, hello@acme.com") == "hello@acme.com"
    assert pick_email("someone@sentry.io") is None
    assert pick_email(None) is None
