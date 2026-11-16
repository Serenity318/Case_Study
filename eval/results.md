# Evaluation results

Generated 2026-11-16T02:42:47.879Z by `npm run eval` from `eval/questions.json` (10 questions).

Embedding `gemini-embedding-2@1536`; generation `gemini-3.5-flash-lite`; similarity threshold 0.65; top 5; no docType filter; 8s pause between questions.

## Summary

| Metric | Value | Counted over |
| --- | --- | --- |
| hit@5 | 100% (7/7) | answerable questions (expectedDoc in the top 5 chunks) |
| hit@1 | 100% (7/7) | answerable questions (expectedDoc is the top chunk) |
| Correct-refusal rate | 100% (3/3) | unanswerable questions (found = false) |
| Answered (found = true) | 100% (7/7) | answerable questions |
| Answered and cited expectedDoc | 100% (7/7) | answerable questions |
| Errors (excluded above) | 0 | all questions |

## Per question

| ID | Question | Expected doc | Top score | Rank | Found | Not-found reason | Cited docs | Outcome | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| q1 | When must the SST-02 return be submitted? | rmcd-sst-return-and-payment-guide-v3.pdf | 0.756 | 1 | yes | - | rmcd-sst-return-and-payment-guide-v3.pdf | OK: answered from expected doc | ranked only #3 in Phase 2 |
| q2 | One of my clients still hasn't paid an invoice I issued a year ago. Since service tax is based on when I get paid, can I keep holding off on declaring it until they actually settle the bill? | rmcd-sst-return-and-payment-guide-v3.pdf | 0.719 | 1 | yes | - | rmcd-sst-return-and-payment-guide-v3.pdf | OK: answered from expected doc | PDF p.8 (printed p.5), para 24. Expected: No - service tax must be accounted for the day after 12 months from the invoice date, even if unpaid |
| q3 | My Sdn Bhd only brings in around RM1.2 million a year, which is well under the RM3 million threshold. Are we still exempt from issuing e-Invoices if our holding company makes over RM5 million annually? | lhdn-einvoice-guideline-v4.8.pdf | 0.800 | 1 | yes | - | lhdn-einvoice-guideline-v4.8.pdf | OK: answered from expected doc | PDF p.15 (s1.6.1(e)) and p.17 (s1.6.10(b)). Multi-section. Expected: No—while businesses with an annual turnover or revenue below RM3,000,000 are generally exempt from implementing e-Invoice, that exemption does not apply if your company is a subsidiary of a holding company with an annual turnover or revenue of at least RM3,000,000. |
| q4 | When must a buyer issue a self-billed e-invoice? | lhdn-einvoice-specific-guideline-v4.9.pdf | 0.814 | 1 | yes | - | lhdn-einvoice-specific-guideline-v4.9.pdf | OK: answered from expected doc | Phase 2 test, p.63 |
| q5 | My company sells commercial trailers, and one of our buyers said they don't need an e-Invoice. Can I just bundle that sale into my monthly consolidated e-Invoice instead? | lhdn-einvoice-specific-guideline-v4.9.pdf | 0.780 | 1 | yes | - | lhdn-einvoice-specific-guideline-v4.9.pdf | OK: answered from expected doc | PDF p.32, s3.7, Table 3.6 row 1 (Automotive). Tests flattened tables. Expected: No—consolidated e-Invoices are prohibited for the sale of any motor vehicle, and the table explicitly defines motor vehicles to include trailers, meaning you must obtain the buyer's details and issue an individual e-Invoice for that transaction. |
| q6 | What is the maximum value of a small value asset? | lhdn-public-ruling-4-2026.pdf | 0.751 | 1 | yes | - | lhdn-public-ruling-4-2026.pdf | OK: answered from expected doc | Phase 2 measurement |
| q7 | I just bought my first home and only started paying loan interest in November, so the interest amount for this year is pretty small. Can I skip claiming the first-home loan interest relief this year and save my 3-year claim window for next year when my full payments kick in? | lhdn-public-ruling-7-2025.pdf | 0.692 | 1 | yes | - | lhdn-public-ruling-7-2025.pdf | OK: answered from expected doc | PDF p.45-46 (printed 42-43), para 6.16.2(c)-(d), Example 39 on PDF p.48. Multi-paragraph. Expected: No—the three consecutive years of assessment for the first residential housing loan interest relief automatically begin in the first year you pay interest on the loan, and you are not allowed to choose or defer which years of assessment to claim. |
| q8 | How do I register for SST with Customs? | _(none: should refuse)_ | 0.741 | - | no | model_declined | - | OK: refused | near-miss, scored 0.741 in Phase 2 |
| q9 | What is the corporate tax rate for SMEs in Malaysia? | _(none: should refuse)_ | 0.668 | - | no | model_declined | - | OK: refused | Malaysian tax, but not in my documents |
| q10 | How do I bake a chocolate cake? | _(none: should refuse)_ | 0.516 | - | no | below_threshold | - | OK: refused | clearly off-topic |

Rank = position (1-5) of the first retrieved chunk from the expected document; `miss` = not in the top 5; `-` = not applicable.
