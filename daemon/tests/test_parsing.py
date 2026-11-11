"""Reading the AI's JSON replies: lenient on wrapping, never guessing an answer."""

from prompts import parse_email_drafts, parse_profile, parse_verdict, parse_verdicts


def test_verdict_tolerates_fences_and_thinking():
    reply = '<think>hmm</think>```json\n{"summary": "Makes apps.", "qualified": true}\n```'
    assert parse_verdict(reply) == (True, "Makes apps.")
    assert parse_verdict('{"qualified": "yes"}') is None
    assert parse_verdict("no json here") is None


def test_batch_verdicts_drop_unclear_answers():
    reply = """{"results": [
        {"number": 1, "qualified": true, "summary": "A"},
        {"number": 2, "qualified": "maybe"},
        {"number": 3, "qualified": false}, {"number": 3, "qualified": true},
        {"number": 9, "qualified": true},
        {"number": "4", "qualified": false}
    ]}"""
    assert parse_verdicts(reply, 4) == {1: (True, "A"), 4: (False, None)}


def test_batch_drafts_need_subject_and_body():
    reply = """{"emails": [
        {"number": 1, "subject": "S1", "body": "B1"},
        {"number": 2, "subject": "", "body": "B2"},
        {"number": 3, "subject": "S3", "body": "B3"}
    ]}"""
    assert parse_email_drafts(reply, 3) == {1: ("S1", "B1"), 3: ("S3", "B3")}


def test_profile_is_cleaned():
    reply = """{"full_name": " Asha ", "headline": "CS student", "skills": ["SQL", "", "Python"],
                "target_roles": ["A", "B", "C", "D"], "experience_years": "1.5", "opportunity_type": "Internship"}"""
    out = parse_profile(reply)
    assert out["full_name"] == "Asha" and out["skills"] == ["SQL", "Python"]
    assert out["target_roles"] == ["A", "B", "C"] and out["experience_years"] == 1.5
    assert out["opportunity_type"] == "internship"
    assert parse_profile('{"full_name": "No role"}') is None
