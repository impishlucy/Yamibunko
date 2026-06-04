export const DEFAULT_PLAYER_ASPECT_RATIO = "16 / 9"

const fourThreeMinRatio = 1.2
const fourThreeMaxRatio = 1.5
const cinematicMinRatio = 2.05

export function getPreferredPlayerAspectRatio(width?: number, height?: number) {
  if (!width || !height || width <= 0 || height <= 0) {
    return DEFAULT_PLAYER_ASPECT_RATIO
  }

  const ratio = width / height

  if (
    (ratio >= fourThreeMinRatio && ratio <= fourThreeMaxRatio) ||
    ratio >= cinematicMinRatio
  ) {
    return `${width} / ${height}`
  }

  return DEFAULT_PLAYER_ASPECT_RATIO
}
