"""config.py's models reject a bad value with a message naming the field."""

import pytest

from core.config_models import AIConfig, ConfigError, EmailConfig, LLMProfile, LoggingConfig

PROFILE = LLMProfile(models="openai/some-model")


def test_valid_values_are_cleaned():
    assert PROFILE.models == ["openai/some-model"]
    assert LoggingConfig(level=" debug ", levels={"scrape": "warning"}).level_for("scrape") == 30
    ai = AIConfig(qualify=PROFILE, email=PROFILE, profile=PROFILE, qualify_batch=10)
    assert ai.updated(email_batch=3).email_batch == 3 and ai.qualify_batch == 10


@pytest.mark.parametrize("make, field", [
    (lambda: AIConfig(qualify=PROFILE, email=PROFILE, profile=PROFILE, qualify_batch=50), "qualify_batch"),
    (lambda: AIConfig(qualify=PROFILE, email=PROFILE, profile=PROFILE, email_batch=True), "email_batch"),
    (lambda: EmailConfig(mode="live"), "mode"),
    (lambda: EmailConfig(delivery="aol"), "delivery"),
    (lambda: EmailConfig(max_sends_per_day="10"), "max_sends_per_day"),
    (lambda: EmailConfig(attach_resum=False), "attach_resum"),
    (lambda: EmailConfig(instructions="x" * 2001), "instructions"),
    (lambda: LLMProfile(models=[]), "models"),
    (lambda: LLMProfile(models=["x"], temperature=3), "temperature"),
    (lambda: LoggingConfig(level="LOUD"), "level"),
])
def test_bad_values_name_the_field(make, field):
    with pytest.raises(ConfigError, match=field):
        make()


def test_updated_is_validated_again():
    with pytest.raises(ConfigError, match="mode"):
        EmailConfig().updated(mode="nope")


def test_dashboard_instructions_reach_the_email_prompts():
    from core.app_settings import EMAIL_COLUMNS, AppSettings
    from prompts import cold_email_batch_prompt, cold_email_prompt

    email = AppSettings(settings={"email_instructions": "  Mention I can start in June.  "}).apply(EmailConfig(), EMAIL_COLUMNS)
    assert email.instructions == "Mention I can start in June."
    assert AppSettings().apply(EmailConfig(), EMAIL_COLUMNS).instructions == ""

    lead = {"name": "Acme", "seeking": "a data analyst internship"}
    assert "start in June" in cold_email_prompt("Asha", lead, "{}", [], instructions=email.instructions)
    assert "start in June" in cold_email_batch_prompt("Asha", [lead], ["{}"], [], email.instructions)
    assert "own instructions" not in cold_email_prompt("Asha", lead, "{}", [])
