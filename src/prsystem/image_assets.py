"""Bounded PNG/JPEG uploads, decoded and re-encoded without source metadata."""
import base64
import binascii
import io

from prsystem.common import DomainError


def menu_image(value):
    from PIL import Image, ImageOps, UnidentifiedImageError
    if not isinstance(value,str) or len(value)>400000:
        raise DomainError('INVALID_MENU_IMAGE')
    try:
        header,encoded=value.split(',',1)
        expected={'data:image/png;base64':'PNG','data:image/jpeg;base64':'JPEG'}[header]
        data=base64.b64decode(encoded,validate=True)
        if not data or len(data)>290000:
            raise ValueError()
        with Image.open(io.BytesIO(data)) as source:
            if source.format!=expected or getattr(source,'n_frames',1)!=1 or not 1<=source.width<=4096 or not 1<=source.height<=4096 or source.width*source.height>4000000:
                raise ValueError()
            source.load()
            image=ImageOps.exif_transpose(source).convert('RGB')
            image.thumbnail((1200,1200))
            out=io.BytesIO()
            # A new image discards all metadata, including EXIF/GPS and profiles.
            clean=Image.new('RGB',image.size);clean.paste(image)
            clean.save(out,format='JPEG',quality=85,optimize=True)
        if len(out.getvalue())>290000:
            raise ValueError()
        return 'data:image/jpeg;base64,'+base64.b64encode(out.getvalue()).decode('ascii')
    except (KeyError,ValueError,OSError,binascii.Error,UnidentifiedImageError,Image.DecompressionBombError):
        raise DomainError('INVALID_MENU_IMAGE') from None
