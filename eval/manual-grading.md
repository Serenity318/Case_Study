# Manual answer grading

Retrieval (eval/results.md) checks which document was cited. This file checks whether the ANSWER was right.
Graded with Claude's assistance; each verdict checked by me against the cited PDF pages. Threshold 0.65.

| ID | Verdict | Reason |
|----|---------|--------|
| q1 | Correct | Last day of the month after the taxable period, the varied-period rule and NIL returns, all cited to the right pages (printed p.2, 4, 5). |
| q2 | WRONG (retrieval miss) | The chunk containing para 24 (the 12-month rule, PDF p.8) was NOT in the top 5; retrieved pages were 2, 10, 2, 3, 9. The document-level hit was correct, but the page-level hit failed, so the model answered from the payment-basis paragraph and left the user's wrong assumption intact. Likely cause: para 24 sits in a "Manner of Furnishing Return" chunk dominated by procedural text. |
| q3 | Correct | Said "No"; the holding-company exception matches s1.6.10(b), p.17. Cited only p.17, not s1.6.1(e) on p.15. Section label on the citation is wrong (heading-detection noise). |
| q4 | Correct | Lists the self-billed transactions (a)-(f) from p.63, plus capital-reduction timing from p.64. Citations distinct per claim. |
| q5 | Correct | Said "No"; motor vehicles, including trailers, can't be consolidated (Table 3.6, p.32). The table row survived being flattened into text. |
| q6 | Correct | RM2,000 from YA2020, cited to para 8.3 (p.7). All 5 retrieved chunks were from the right ruling. The earlier run also listed the pre-2020 limits; this run didn't, so the level of detail varies between runs. |
| q7 | Correct | Said "No"; three consecutive YAs from the first year of interest, no choosing (PR 7/2025, printed p.42-43). Section label shows 6.10 instead of 6.16 (heading-detection noise). |
| q8 | Correct refusal | Layer 2 (model declined), score 0.741. |
| q9 | Correct refusal | Layer 2, score 0.668. At 0.73 this was a layer-1 refusal; lowering the threshold moved it to layer 2. |
| q10 | Correct refusal | Layer 1 (below threshold), score 0.516. |

Summary: retrieval found the right document 7/7, but the right page only 6/7 (q2 missed para 24). Answers fully correct 6/7. One answer (q2) was misleading because the needed chunk was never retrieved, which document-level metrics cannot detect.