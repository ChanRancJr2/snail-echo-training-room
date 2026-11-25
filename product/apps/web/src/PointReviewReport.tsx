import { correspondingRetell, type ReviewPoint, type summarizePointReview } from './round-report.ts';

export type ReportPoint = ReviewPoint & { listenerQuote: string | null };

export const reviewTitle = '表达者审核结果';
export const unselectedTitle = '有问题的要点 · 逐条对照';
export const missingReview = '本轮未保存准确要点的人工审核结果。';

export function PointReviewReport({ review, anonymous = false, transcript }: {
  review: ReturnType<typeof summarizePointReview<ReportPoint>>;
  anonymous?: boolean;
  transcript: string | null | undefined;
}) {
  return <>
    <section class="point-review-result">
      <h2>{reviewTitle}</h2>
      {review ? <p>准确度：<strong>{review.accurate} / {review.total}</strong></p> : <p>{missingReview}</p>}
    </section>
    {review && !anonymous && <section class="point-review-details">
      <h3>{unselectedTitle}</h3>
      {review.total === 0 ? <p>本轮没有可核对的要点。</p> : review.unselected.length === 0 ? <p>所有要点均已勾选。</p> :
        review.unselected.map((point, index) => <article class="comparison-item" key={point.id}>
          <h4>{index + 1}. {point.original}</h4>
          <p>复述转写原句：{correspondingRetell(point.listenerQuote, transcript)}</p>
        </article>)}
    </section>}
  </>;
}
