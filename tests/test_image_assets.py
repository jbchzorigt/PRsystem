import base64
import importlib.util
import io
import unittest
from prsystem.common import DomainError
from prsystem.image_assets import menu_image


@unittest.skipUnless(importlib.util.find_spec('PIL'),'Pillow is not installed')
class MenuImageTests(unittest.TestCase):
    def image(self,format='PNG',size=(8,8)):
        from PIL import Image
        stream=io.BytesIO();Image.new('RGB',size,'red').save(stream,format=format)
        return f'data:image/{"jpeg" if format=="JPEG" else format.lower()};base64,'+base64.b64encode(stream.getvalue()).decode()

    def test_png_and_jpeg_reencoded_as_bounded_jpeg(self):
        from PIL import Image
        for format in ('PNG','JPEG'):
            result=menu_image(self.image(format,(1300,1000)))
            self.assertTrue(result.startswith('data:image/jpeg;base64,'))
            with Image.open(io.BytesIO(base64.b64decode(result.split(',')[1]))) as image:
                self.assertEqual(image.size,(1200,923))
                self.assertEqual(len(image.getexif()),0)

    def test_svg_mismatch_truncated_and_oversized_rejected(self):
        cases=['data:image/svg+xml;base64,'+base64.b64encode(b'<svg/>').decode(),self.image().replace('image/png','image/jpeg'),
               'data:image/png;base64,aW52YWxpZA==','data:image/png;base64,'+'a'*400000,self.image(size=(4097,1))]
        for value in cases:
            with self.subTest(value=value[:40]),self.assertRaisesRegex(DomainError,'INVALID_MENU_IMAGE'):
                menu_image(value)

    def test_exif_metadata_removed(self):
        from PIL import Image
        stream=io.BytesIO();image=Image.new('RGB',(8,8),'red');exif=Image.Exif();exif[0x010e]='private source metadata';image.save(stream,format='JPEG',exif=exif)
        result=menu_image('data:image/jpeg;base64,'+base64.b64encode(stream.getvalue()).decode())
        self.assertNotIn(b'private source metadata',base64.b64decode(result.split(',')[1]))
