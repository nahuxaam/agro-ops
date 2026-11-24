// Varieties from the crop list. Seeded once; edits in the app are kept.
// Names stay as written, including casing.
export const CROP_LIST = [
  'Banana - Bonthirayikeyo',
  'Banana - fuskeyo',
  'Banana - Maalhoskeyo',
  'Banana - Sanfa keyo',
  'Bird Chilli',
  'Brinjal',
  'Bush Beans',
  'Butternut',
  'Butternut - Hiyala',
  'Butternut - Iris IHS 375',
  'cabbage',
  'Capsicum',
  'Chinese Cabbage',
  'Coconut',
  'Cucumber - Madam',
  'Cucumber - Riches',
  'Honey Dew melon - Jade lady',
  'Honey Melon - Sweetie',
  'Lettuce Coral - Grand Rapid',
  'Okra (Baamiyaa Tholhi)',
  'Papaya - Holland',
  'Papaya - Red Lady',
  'Papaya - Sweet rosa',
  'Passion Fruit',
  'Pumpkin',
  'Pumpkin - Hiyala',
  'Pumpkin - PK 4409',
  'Pumpkin - Marvinna',
  'Rock Melon - Sweetie',
  'Snake Gourd',
  'Sponge Gourd',
  'Sweet Melon - Brilliant',
  'Tomato',
  'Watermelon - Diana',
  'Watermelon - Jamaica 753',
  'Watermelon - Klondike',
  'Watermelon - Omega',
  'Watermelon - Orleans 232',
  'Watermelon - Soreness',
  'Watermelon - Tum004',
  'Watermelon - Twinkle',
];

export function splitCropName(name) {
  const i = name.indexOf(' - ');
  if (i === -1) return { crop: name, variety: '' };
  return { crop: name.slice(0, i), variety: name.slice(i + 3) };
}
