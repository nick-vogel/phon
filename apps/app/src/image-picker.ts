import type { AttachmentPickers, PickedAttachment } from '@kesha-antonov/react-native-chat'
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator'
import * as ImagePicker from 'expo-image-picker'
import { keepsAsPicked, uploadSize } from './photo-size'

/**
 * The composer's photo pickers, for the chat library's Gallery and Camera tabs. Both pick images
 * only. The system photo picker needs no access to the whole library, and iOS is asked for the
 * compatible representation, so a photo comes as JPEG rather than HEIC, which the server refuses.
 * The picker keeps full quality: below 1, Android's picker re-encodes a GIF or WebP as a still
 * JPEG, which loses its animation. The JPEG encode happens when a photo is shrunk instead.
 */
const OPTIONS: ImagePicker.ImagePickerOptions = {
  mediaTypes: 'images',
  quality: 1,
  preferredAssetRepresentationMode:
    ImagePicker.UIImagePickerPreferredAssetRepresentationMode.Compatible,
}

/** The JPEG quality a shrunk photo is saved at. */
const COMPRESS = 0.8

export const imagePickers: AttachmentPickers = {
  async gallery() {
    return picked(await ImagePicker.launchImageLibraryAsync(OPTIONS))
  },
  async camera() {
    const permission = await ImagePicker.requestCameraPermissionsAsync()
    if (!permission.granted) return []
    return picked(await ImagePicker.launchCameraAsync(OPTIONS))
  },
}

/**
 * What was picked, as the chat library takes it: nothing when the person cancelled. Each photo is
 * shrunk before it uploads; a GIF or WebP passes through as picked, so its animation survives.
 */
async function picked(result: ImagePicker.ImagePickerResult): Promise<PickedAttachment[]> {
  if (result.canceled) return []
  return Promise.all(result.assets.map((asset) => attachment(asset)))
}

async function attachment(asset: ImagePicker.ImagePickerAsset): Promise<PickedAttachment> {
  const image = {
    uri: asset.uri,
    ...(asset.mimeType !== undefined && { mimeType: asset.mimeType }),
  }
  if (keepsAsPicked(image)) return asPicked(asset)
  return shrunk(asset)
}

/** The asset exactly as the picker gave it. */
function asPicked(asset: ImagePicker.ImagePickerAsset): PickedAttachment {
  const attachment: PickedAttachment = { type: 'image', uri: asset.uri }
  if (asset.width > 0) attachment.width = asset.width
  if (asset.height > 0) attachment.height = asset.height
  if (asset.mimeType !== undefined) attachment.mimeType = asset.mimeType
  if (asset.fileName !== undefined && asset.fileName !== null) attachment.fileName = asset.fileName
  return attachment
}

/**
 * The asset scaled to its upload size and saved as JPEG. The size comes from the loaded image, so
 * its orientation is already applied, rather than from the asset, whose size can be 0.
 */
async function shrunk(asset: ImagePicker.ImagePickerAsset): Promise<PickedAttachment> {
  const loaded = await ImageManipulator.manipulate(asset.uri).renderAsync()
  const size = uploadSize(loaded.width, loaded.height)
  const sized =
    size.width === loaded.width && size.height === loaded.height
      ? loaded
      : await ImageManipulator.manipulate(loaded).resize(size).renderAsync()
  const saved = await sized.saveAsync({ format: SaveFormat.JPEG, compress: COMPRESS })
  const attachment: PickedAttachment = {
    type: 'image',
    uri: saved.uri,
    width: saved.width,
    height: saved.height,
    mimeType: 'image/jpeg',
  }
  if (asset.fileName !== undefined && asset.fileName !== null)
    attachment.fileName = asset.fileName.replace(/\.[^./]*$/, '.jpg')
  return attachment
}
