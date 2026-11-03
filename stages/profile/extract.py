"""Resume file -> plain text (pure, no network). PDF via pypdf, DOCX via python-docx."""

from __future__ import annotations

import io
import re

PDF_MIME = "application/pdf"
DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"


class UnreadableResume(ValueError):
    """The file isn't a PDF or DOCX we can read, or holds no text (a scanned image, say)."""


def kind_of(filename: str, mime: str = "") -> str:
    """'pdf' or 'docx', from the MIME type or else the file extension. Raises UnreadableResume otherwise."""
    name = filename.lower()
    if mime == PDF_MIME or name.endswith(".pdf"):
        return "pdf"
    if mime == DOCX_MIME or name.endswith(".docx"):
        return "docx"
    raise UnreadableResume(f"'{filename}' is not a PDF or DOCX file")


def _pdf_text(data: bytes) -> str:
    from pypdf import PdfReader
    from pypdf.errors import PdfReadError

    try:
        reader = PdfReader(io.BytesIO(data))
        return "\n".join(page.extract_text() or "" for page in reader.pages)
    except (PdfReadError, ValueError, KeyError) as exc:
        raise UnreadableResume(f"the PDF could not be read ({exc})") from exc


def _docx_text(data: bytes) -> str:
    from docx import Document

    try:
        doc = Document(io.BytesIO(data))
    except Exception as exc:  # noqa: BLE001 — python-docx raises a variety of zip / XML errors
        raise UnreadableResume(f"the DOCX could not be read ({type(exc).__name__})") from exc
    parts = [p.text for p in doc.paragraphs]
    for table in doc.tables:
        for row in table.rows:
            parts.append(" | ".join(cell.text for cell in row.cells))
    return "\n".join(parts)


def resume_text(data: bytes, filename: str, mime: str = "") -> str:
    """The resume's text, whitespace tidied. Raises UnreadableResume for a file with no readable text."""
    text = _pdf_text(data) if kind_of(filename, mime) == "pdf" else _docx_text(data)
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r"\n\s*\n+", "\n\n", text).strip()
    if len(text) < 50:
        raise UnreadableResume("the file holds almost no text (a scanned image?); upload a text PDF or DOCX")
    return text
