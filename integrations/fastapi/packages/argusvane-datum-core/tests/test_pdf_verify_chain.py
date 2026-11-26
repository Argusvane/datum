"""`intact` over signatures that rely on later signatures: linear work, the same verdicts.

The relied-on graph comes from the file: a certification's later revisions name the signatures they rely on, and each
of them may rely on later ones in turn. A file of n signatures where each relies on every later one has 2^(n-1) paths
from the first, so the host judges each signature once and reads the answer it already has. A signature that relies,
through any path, on itself is never intact, and neither is any signature that relies on it.
"""

import random
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

import pytest
from pdf_support import later_revisions, signature_report, started_pdf, verify_reply

from datum_core.pdf import PdfTrustPolicy
from datum_core.pdf.outcomes import Verified
from datum_core.pdf.verify import assemble_report
from datum_core.testing.tsa_pki import DocumentPki, build_document_pki
from datum_sandbox.protocol import PdfVerified

DATA = b"%PDF-1.7\nchain\n%%EOF\n"
NOW = datetime(2026, 10, 20, 12, tzinfo=UTC)


@pytest.fixture(scope="module")
def pki() -> DocumentPki:
    return build_document_pki()


@dataclass(frozen=True, slots=True)
class Node:
    """One signature of a synthetic file: its own facts hold or not, it covers the document or relies on `relied`."""

    holds: bool = True
    covers: bool = False
    relied: tuple[int, ...] = ()


def _range(index: int) -> list[int]:
    return [0, 10, 20 + 20 * index, 30 + 20 * index]


def reports_of(pki: DocumentPki, nodes: Sequence[Node]) -> list[dict[str, Any]]:
    """The program's reports for `nodes`: signature i is field `S<i>`, its relied-on entries name `S<j>` by range."""
    return [
        signature_report(
            pki.signer,
            field_name=f"S{index}",
            byte_range=_range(index),
            digest_matches=node.holds,
            covers_document=node.covers,
            certification=None if node.covers else "formFilling",
            later_revisions=None
            if node.covers
            else later_revisions(
                permitted=True, relied_on=[{"field": f"S{j}", "byteRange": _range(j)} for j in node.relied]
            ),
        )
        for index, node in enumerate(nodes)
    ]


def expected(nodes: Sequence[Node]) -> list[bool]:
    """The verdicts by following every path from each signature, a signature on the current path failing the path."""

    def holds(index: int, path: frozenset[int]) -> bool:
        node = nodes[index]
        if not node.holds:
            return False
        if node.covers:
            return True
        targets = [j for j in node.relied if j != index]
        if len(targets) != len(node.relied):
            return False  # an entry naming the signature itself matches no other report
        here = path | {index}
        return all(j not in here and holds(j, here) for j in targets)

    return [holds(index, frozenset()) for index in range(len(nodes))]


def each_relies_on_every_later(count: int, *, last: Node | None = None) -> list[Node]:
    nodes = [Node(relied=tuple(range(index + 1, count))) for index in range(count - 1)]
    nodes.append(last if last is not None else Node(covers=True))
    return nodes


class CountingReport(dict[str, Any]):
    """A report that counts how often its `laterRevisions` are read."""

    reads = 0

    def get(self, key: str, default: Any = None) -> Any:
        if key == "laterRevisions":
            CountingReport.reads += 1
        return super().get(key, default)


def assembled(pki: DocumentPki, reports: Sequence[dict[str, Any]]) -> list[bool]:
    verified = PdfVerified(signatures=tuple(reports))
    report = assemble_report(DATA, verified, policy=PdfTrustPolicy(anchors=(pki.signer.root_der,)), now=NOW)
    return [verdict.intact for verdict in report.signatures]


@pytest.mark.timeout(60)
def test_forty_signatures_each_relying_on_every_later_one_are_judged_quickly_and_all_intact(pki: DocumentPki) -> None:
    nodes = each_relies_on_every_later(40)
    with started_pdf(pdf_trust_policy=PdfTrustPolicy(anchors=(pki.signer.root_der,))) as rig:
        rig.runtime.on("verify", lambda _request: verify_reply(*reports_of(pki, nodes)))
        outcome = rig.verify(DATA)
    assert isinstance(outcome, Verified), outcome
    assert [verdict.intact for verdict in outcome.report.signatures] == [True] * 40


@pytest.mark.timeout(60)
def test_a_forty_signature_chain_whose_last_signature_relies_on_the_first_is_never_intact(pki: DocumentPki) -> None:
    nodes = each_relies_on_every_later(40, last=Node(relied=(0,)))
    assert assembled(pki, reports_of(pki, nodes)) == [False] * 40


def test_each_signature_is_followed_once_however_many_paths_lead_to_it(pki: DocumentPki) -> None:
    nodes = each_relies_on_every_later(16)
    reports = [CountingReport(report) for report in reports_of(pki, nodes)]
    CountingReport.reads = 0
    assert assembled(pki, reports) == [True] * 16
    assert CountingReport.reads <= len(nodes)  # 2^15 reads when every path is followed again


def test_a_broken_signature_in_the_middle_breaks_every_one_before_it_and_none_after(pki: DocumentPki) -> None:
    nodes = each_relies_on_every_later(12)
    nodes[6] = Node(holds=False, relied=nodes[6].relied)
    assert assembled(pki, reports_of(pki, nodes)) == [False] * 7 + [True] * 5


def test_a_signature_two_paths_reach_is_not_a_cycle(pki: DocumentPki) -> None:
    nodes = [Node(relied=(1, 2)), Node(relied=(3,)), Node(relied=(3,)), Node(covers=True)]
    assert assembled(pki, reports_of(pki, nodes)) == [True, True, True, True]


def test_a_cycle_breaks_its_members_and_whoever_relies_on_them_but_not_what_they_rely_on(pki: DocumentPki) -> None:
    nodes = [Node(relied=(1,)), Node(relied=(2, 3)), Node(relied=(1,)), Node(covers=True)]
    assert assembled(pki, reports_of(pki, nodes)) == [False, False, False, True]


def test_verdicts_match_following_every_path_on_random_graphs(pki: DocumentPki) -> None:
    chooser = random.Random(20261020)  # noqa: S311 - a fixed sample of graphs, not a secret
    for _ in range(60):
        count = chooser.randint(1, 7)
        nodes = [
            Node(
                holds=chooser.random() > 0.15,
                covers=chooser.random() < 0.25,
                relied=tuple(sorted(chooser.sample(range(count), chooser.randint(0, min(3, count))))),
            )
            for _ in range(count)
        ]
        assert assembled(pki, reports_of(pki, nodes)) == expected(nodes), nodes
